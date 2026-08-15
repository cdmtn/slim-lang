import keytar from "keytar";

const SERVICE = "slim-package-manager";
const ACCOUNT = "github";

export async function saveGitHubToken(token) {
    if (!token) {
        throw new Error("GitHub token is empty");
    }

    await keytar.setPassword(
        SERVICE,
        ACCOUNT,
        token
    );
}

export async function getGitHubToken() {
    return await keytar.getPassword(
        SERVICE,
        ACCOUNT
    );
}

export async function deleteGitHubToken() {
    return await keytar.deletePassword(
        SERVICE,
        ACCOUNT
    );
}