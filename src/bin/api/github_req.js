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

    const data = response.status === 204 ? null : await response.json().catch(() => null);

    if (!response.ok) {
        throw new Error(data?.message || `GitHub API error: ${response.status}`);
    }

    return data;
}

async function getFiles(dir, base = dir) {
    const files = [];

    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) files.push(...await getFiles(fullPath, base));
        else if (entry.isFile()) files.push({ path: path.relative(base, fullPath).replaceAll("\\", "/"), fullPath });
    }

    return files;
}

async function commitDirectory({ token, repo, dir, message, branch = "main" }) {
    const files = await getFiles(dir);
    if (files.length === 0) throw new Error("Package directory is empty");

    const reference = await githubRequest(token, `/repos/${repo}/git/ref/heads/${branch}`);
    const parentSha = reference.object.sha;
    const parentCommit = await githubRequest(token, `/repos/${repo}/git/commits/${parentSha}`);

    const tree = [];
    for (const file of files) {
        const blob = await githubRequest(token, `/repos/${repo}/git/blobs`, {
            method: "POST",
            body: JSON.stringify({ content: await fs.readFile(file.fullPath, "base64"), encoding: "base64" })
        });
        tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    const newTree = await githubRequest(token, `/repos/${repo}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree })
    });

    const commit = await githubRequest(token, `/repos/${repo}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message, tree: newTree.sha, parents: [parentSha] })
    });

    await githubRequest(token, `/repos/${repo}/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha })
    });

    return { commit: commit.sha, tree: newTree.sha };
}

export async function publishToGitHub({ token, repo, contentPath, branch = "main" }) {
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
        return { success: false, msg: `Invalid GitHub repository: ${repo}` };
    }

    try {
        const repository = await githubRequest(token, `/repos/${repo}`);
        const { commit } = await commitDirectory({ token, repo, dir: contentPath, message: "Publish package", branch });

        return { success: true, msg: `Published ${repo}`, repo: repository.full_name, commit };
    }
    catch (error) {
        return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
}

export async function updateGitHubRepo({ token, repo, packagePath, version, message = `Release ${version}` }) {
    try {
        const { commit, tree } = await commitDirectory({ token, repo, dir: packagePath, message });

        await githubRequest(token, `/repos/${repo}/git/refs`, {
            method: "POST",
            body: JSON.stringify({ ref: `refs/tags/v${version}`, sha: commit })
        });

        return { success: true, commit, tree, version, tag: `v${version}` };
    }
    catch (error) {
        return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
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
