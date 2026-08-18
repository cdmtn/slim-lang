import fs from "node:fs/promises";
import path from "node:path";

export const GITHUB_API = "https://api.github.com";
export const API_VERSION = "2026-03-10";

export function githubHeaders(token, extra = {}) {
    return {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        ...extra
    };
}

export async function githubRequest(token, url, options = {}) {
    const response = await fetch(`${GITHUB_API}${url}`, {
        ...options,
        headers: githubHeaders(token, {
            "Content-Type": "application/json",
            ...options.headers
        })
	});

	const data = await response.json();

	if (!response.ok) {
        throw new Error(
            data.message || `GitHub API error: ${response.status}`
        );
    }

    return data;
}

async function getFiles(dir, base = dir) {
    const entries = await fs.readdir(dir, {
        withFileTypes: true
    });

    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            files.push(
                ...(await getFiles(fullPath, base))
            );
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        files.push({
            path: path.relative(base, fullPath).replaceAll("\\", "/"),
            fullPath
        });
    }

    return files;
}

export async function publishToGitHub({
    token,
    repo,
    contentPath,
    branch = "main"
}) {
    try {
        const [owner, repoName] = repo.split("/");

        if (!owner || !repoName || repo.split("/").length !== 2) {
            return {
                success: false,
                msg: `Invalid GitHub repository: ${repo}`
            };
        }

        const repository = await githubRequest(
            token,
            `/repos/${owner}/${repoName}`
        );

        const files = await getFiles(contentPath);

        if (!files.length) {
            return {
                success: false,
                msg: "Package directory is empty"
            };
        }

        const reference = await githubRequest(
            token,
            `/repos/${owner}/${repoName}/git/ref/heads/${branch}`
        );

        const parentSha = reference.object.sha;

        const parentCommit = await githubRequest(
            token,
            `/repos/${owner}/${repoName}/git/commits/${parentSha}`
        );

        const tree = [];

        for (const file of files) {
            const content = await fs.readFile(
                file.fullPath,
                "base64"
            );

            const blob = await githubRequest(
                token,
                `/repos/${owner}/${repoName}/git/blobs`,
                {
                    method: "POST",
                    body: JSON.stringify({
                        content,
                        encoding: "base64"
                    })
                }
            );

            tree.push({
                path: file.path,
                mode: "100644",
                type: "blob",
                sha: blob.sha
            });
        }

        const newTree = await githubRequest(
            token,
            `/repos/${owner}/${repoName}/git/trees`,
            {
                method: "POST",
                body: JSON.stringify({
                    base_tree: parentCommit.tree.sha,
                    tree
                })
            }
        );

        const commit = await githubRequest(
            token,
            `/repos/${owner}/${repoName}/git/commits`,
            {
                method: "POST",
                body: JSON.stringify({
                    message: "Publish package",
                    tree: newTree.sha,
                    parents: [parentSha]
                })
            }
        );

        await githubRequest(
            token,
            `/repos/${owner}/${repoName}/git/refs/heads/${branch}`,
            {
                method: "PATCH",
                body: JSON.stringify({
                    sha: commit.sha
                })
            }
        );

        return {
            success: true,
            msg: `Published ${repo}`,
            repo: repository.full_name,
            commit: commit.sha
        };
    }
    catch (error) {
        return {
            success: false,
            msg: error instanceof Error
                ? error.message
                : String(error)
        };
    }
}

export async function updateGitHubRepo({
    token,
    repo,
    packagePath,
    version,
    message = `Release ${version}`
}) {
    const branch = await githubRequest(
        token,
        `/repos/${repo}/git/ref/heads/main`
    );

    const parentSha = branch.object.sha;

    const parentCommit = await githubRequest(
        token,
        `/repos/${repo}/git/commits/${parentSha}`
    );

    const baseTreeSha = parentCommit.tree.sha;

    const files = await getFiles(packagePath);

    if (files.length === 0) {
        throw new Error("Package directory is empty");
    }

	const tree = [];

	for (const file of files) {
        const content = await fs.readFile(file.fullPath);

        const blob = await githubRequest(
            token,
            `/repos/${repo}/git/blobs`,
            {
                method: "POST",
                body: JSON.stringify({
                    content: content.toString("base64"),
                    encoding: "base64"
                })
            }
        );

        tree.push({
            path: file.path,
            mode: "100644",
            type: "blob",
            sha: blob.sha
        });
    }

    const newTree = await githubRequest(
        token,
        `/repos/${repo}/git/trees`,
        {
            method: "POST",
            body: JSON.stringify({
                base_tree: baseTreeSha,
                tree
            })
        }
    );

    const commit = await githubRequest(
        token,
        `/repos/${repo}/git/commits`,
        {
            method: "POST",
            body: JSON.stringify({
                message,
                tree: newTree.sha,
                parents: [parentSha]
            })
        }
	);

    await githubRequest(
        token,
        `/repos/${repo}/git/refs/heads/main`,
        {
            method: "PATCH",
            body: JSON.stringify({
                sha: commit.sha
            })
        }
    );

    const tagRef = `refs/tags/v${version}`;

    await githubRequest(
        token,
        `/repos/${repo}/git/refs`,
        {
            method: "POST",
            body: JSON.stringify({
                ref: tagRef,
                sha: commit.sha
            })
        }
    );

    return {
        success: true,
        commit: commit.sha,
        tree: newTree.sha,
        version,
        tag: `v${version}`
    };
}

export async function createGitHubRepo(token, repository, organization = false) {
    const match = repository.match(
        /^([a-zA-Z0-9-]+)\/([a-zA-Z0-9._-]+)$/
    );

    if (!match) {
        return {
            success: false,
            msg: "Repository must have format user/repo"
        };
    }

    const [, owner, repo] = match;

    try {
        const check = await fetch(
            `${GITHUB_API}/repos/${owner}/${repo}`,
            {
                headers: githubHeaders(token)
            }
        );

        if (check.ok) {
            return {
                success: false,
                msg: `Repository ${repository} already exists`
            };
        }

        if (check.status !== 404) {
            const data = await check.json();

            return {
                success: false,
                msg: data.message || `GitHub API error: ${check.status}`
            };
        }

        // For a user repo the owner must be the authenticated account. For an
        // organization repo the owner is the org, so that check is skipped and
        // the repo is created through the org endpoint (GitHub rejects it if
        // the account lacks permission).
        if (!organization) {
            const userResponse = await fetch(
                `${GITHUB_API}/user`,
                {
                    headers: githubHeaders(token)
                }
            );

            if (!userResponse.ok) {
                const data = await userResponse.json();

                return {
                    success: false,
                    msg: data.message || "Failed to get GitHub user"
                };
            }

            const user = await userResponse.json();

            if (user.login.toLowerCase() !== owner.toLowerCase()) {
                return {
                    success: false,
                    msg: `You cannot create ${repository}. Your GitHub account is ${user.login}`
                };
            }
        }

        const createUrl = organization
            ? `${GITHUB_API}/orgs/${owner}/repos`
            : `${GITHUB_API}/user/repos`;

        const response = await fetch(
            createUrl,
            {
                method: "POST",
                headers: githubHeaders(token, {
                    "Content-Type": "application/json"
                }),
                body: JSON.stringify({
                    name: repo,
                    private: false,
                    auto_init: true
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            return {
                success: false,
                msg: data.message || `GitHub API error: ${response.status}`
            };
        }

        return {
            success: true,
            msg: `Repository ${repository} created`,
            repo: data
        };
    }
    catch (error) {
        return {
            success: false,
            msg: error instanceof Error
                ? error.message
                : String(error)
        };
    }
}

export async function deleteGitHubRepo(token, repository) {
    const match = repository.match(
        /^([a-zA-Z0-9-]+)\/([a-zA-Z0-9._-]+)$/
    );

    if (!match) {
        return {
            success: false,
            msg: "Repository must have format user/repo"
        };
    }

    const [, owner, repo] = match;

    try {
        const response = await fetch(
            `${GITHUB_API}/repos/${owner}/${repo}`,
            {
                method: "DELETE",
                headers: githubHeaders(token)
            }
        );

        if (response.status === 204) {
            return {
                success: true,
                msg: `Repository ${repository} deleted`
            };
        }

        const data = await response.json().catch(() => null);

        return {
            success: false,
            msg: data?.message || `GitHub API error: ${response.status}`
        };
    }
    catch (error) {
        return {
            success: false,
            msg: error instanceof Error
                ? error.message
                : String(error)
        };
    }
}