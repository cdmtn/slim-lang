const API_URL = "https://codemotion.yurba.one/api/spm"

export async function publishPackage({ token, name, version, github, description = "" }) {
	const res = await fetch(`${API_URL}/publish`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			github_token: token,
			name,
			description,
			version,
			github,
		}),
	});

	const data = await res.json();

	if (!data.success) {
		return {
			success: false,
			content: data.result
		}
	}

	return {
		success: true,
		content: data.result
	}
}

export async function getPackage({ name }) {
	const res = await fetch(`${API_URL}/install?name=${name}`, {
		method: "GET",
		headers: { "Content-Type": "application/json" }
	});

	const data = await res.json();

	if (!data.success) {
		return {
			success: false,
			content: data.result
		}
	}

	return {
		success: true,
		content: data.result
	}
}

export async function updatePackage({ token, name, description, version, github }) {
	const res = await fetch(`${API_URL}/update`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			github_token: token,
			name,
			description,
			version,
			github,
		}),
	});

	const data = await res.json();

	if (!data.success) {
		return {
			success: false,
			content: data.result
		}
	}

	return {
		success: true,
		content: data.result
	}
}

export async function removePackage({ token, name }) {
	const res = await fetch(`${API_URL}/remove`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			github_token: token,
			name
		}),
	});

	const data = await res.json();

	if (!data.success) {
		return {
			success: false,
			content: data.result
		}
	}

	return {
		success: true,
		content: data.result
	}
}