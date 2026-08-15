import { formatBold, formatItalic } from "../helpers.js";

const CLIENT_ID = "Iv23lijjcVMtJwfS18dj";

const DEVICE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

export async function loginGitHub() {
    if (!CLIENT_ID) {
        throw new Error("GITHUB_CLIENT_ID is not configured");
    }

    const response = await fetch(DEVICE_URL, {
        method: "POST",
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            client_id: CLIENT_ID
        })
	});

    if (!response.ok) {
        throw new Error("Failed to start GitHub authorization");
    }

	const data = await response.json();

	console.log("\n");
    console.log("Open:", formatItalic.underline(data.verification_uri));
    console.log(`Code: ${formatBold(data.user_code)}`);
	console.log("");
	console.log("Open the link and paste the code into the fields you see. Then, follow the steps");

    let interval = data.interval || 5;

    while (true) {
        await sleep(interval * 1000);

        const tokenResponse = await fetch(TOKEN_URL, {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                device_code: data.device_code,
                grant_type:
                    "urn:ietf:params:oauth:grant-type:device_code"
            })
        });

		const tokenData = await tokenResponse.json();

		if (tokenData.access_token) {
            return tokenData.access_token;
        }

        if (tokenData.error === "authorization_pending") {
            continue;
        }

        if (tokenData.error === "slow_down") {
            interval += 5;
            continue;
        }

        if (tokenData.error === "access_denied") {
            throw new Error("GitHub authorization denied");
        }

        if (
            tokenData.error === "expired_token"
        ) {
            throw new Error("GitHub authorization expired");
        }

        throw new Error(
            tokenData.error_description ||
            "GitHub authorization failed"
        );
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}