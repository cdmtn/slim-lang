import { GITHUB_API, githubHeaders } from "./github_req.js";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import * as tar from 'tar'

export async function getGitHubUser(token) {
    const response = await fetch(
        `${GITHUB_API}/user`,
        {
            headers: githubHeaders(token)
        }
    );

    if (!response.ok) {
        throw new Error("GitHub token is invalid");
    }

    return response.json();
}

export async function getGitHubRepo(token, repo) {
    const response = await fetch(
        `${GITHUB_API}/repos/${repo}`,
        {
            headers: githubHeaders(token)
        }
    );

    if (!response.ok) {
        throw new Error(
            `GitHub repository "${repo}" not found`
        );
    }

    return response.json();
}

export async function getPermission(token, repo, username) {
    const response = await fetch(
        `${GITHUB_API}/repos/${repo}/collaborators/${username}/permission`,
        {
            headers: githubHeaders(token)
        }
    );

    if (!response.ok) {
        throw new Error(
            "Unable to verify repository permissions"
        );
    }

    return response.json();
}

async function extractTarGz(file, destination) {
    await tar.x({
        file,
        cwd: destination,
        strip: 1
    });
}

export async function downloadGitHubRepo(
    token,
    repository,
    destination,
    version = null
) {
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
        const ref = version
            ? `tarball/v${version}`
            : "tarball/main";

        const response = await fetch(
            `${GITHUB_API}/repos/${owner}/${repo}/${ref}`,
            {
                headers: githubHeaders(token)
            }
        );

        if (!response.ok) {
            const data = await response.json().catch(() => null);

            return {
                success: false,
                msg: data?.message || `GitHub API error: ${response.status}`
            };
        }

        const tempFile = path.join(
            os.tmpdir(),
            `spm-${owner}-${repo}-${Date.now()}.tar.gz`
        );

        await pipeline(
            response.body,
            createWriteStream(tempFile)
        );

        await fs.promises.mkdir(destination, {
            recursive: true
        });

        await extractTarGz(tempFile, destination);

        await fs.promises.unlink(tempFile);

        return {
            success: true,
            msg: `Repository ${repository} downloaded`,
            path: destination
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