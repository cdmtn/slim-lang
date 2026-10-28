const API_URL = "https://codemotion.yurba.one/api/spm"

async function request(endpoint, body) {
	const res = await fetch(`${API_URL}${endpoint}`, body === undefined
		? { method: "GET", headers: { "Content-Type": "application/json" } }
		: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

	let data
	try {
		data = await res.json()
	} catch {
		return { success: false, content: `SPM registry returned HTTP ${res.status}` }
	}

	return { success: !!data.success, content: data.result }
}

export function publishPackage({ token, name, version, github, description = "" }) {
	return request("/publish", { github_token: token, name, description, version, github })
}

export function getPackage({ name }) {
	return request(`/install?name=${encodeURIComponent(name)}`)
}

export function updatePackage({ token, name, description, version, github }) {
	return request("/update", { github_token: token, name, description, version, github })
}

export function removePackage({ token, name }) {
	return request("/remove", { github_token: token, name })
}
