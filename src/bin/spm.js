#!/usr/bin/env node

import { Command } from "commander";
import { formatError, formatBold, formatItalic, formatSuccess, createFolder, createFile } from "./helpers.js"
import pkg from "../../package.json" with { type: "json" };
import { log, isPackageExists, rootPath, deleteDirectory, loading, delay } from "./helpers.js";

import fs from "node:fs"
import path from "node:path"
import { getSPM } from "./parsers/spm.js";
import { loginGitHub } from "./api/github_auth.js";
import { deleteGitHubToken, getGitHubToken, saveGitHubToken } from "./api/storage.js";
import { downloadGitHubRepo, getGitHubUser } from "./api/github_get.js";

import { getPackage, publishPackage, removePackage, updatePackage } from "./api/spm.js"
import { createGitHubRepo, deleteGitHubRepo, githubHeaders, publishToGitHub, updateGitHubRepo } from "./api/github_req.js";

import open from "open";

export const spm = new Command();

function spmlog(...args) {
	console.log("[SPM]", ...args)
}
function errlog(...args) {
	console.log(formatError(...args))
}

const packagesPath = path.join(rootPath, "packages")

function renderObject(obj, indent = 0) {
    let output = "";
    const prefix = " ".repeat(indent);

    Object.entries(obj).forEach(([key, value]) => {
        if (value && typeof value === "object" && !Array.isArray(value)) {
            output += `\n${formatItalic(prefix)}${formatBold(key)}:`;
            output += renderObject(value, indent + 2);
        } else {
            output += `\n${formatItalic(prefix)}${formatBold(key)}: ${value}`;
        }
    });

    return output;
}

function renderBlock({ name, content }) {
	function generateSepLines(len) {
		let line = `-------------------------------------`

		if (len) {
			for (let i = 0; i < len; i++) {
				line += "-"
			}
		}

		return line
	}

	const nameLen = name.length

	return `${formatSuccess(name)} ${generateSepLines()}` +
	content +
	`\n${generateSepLines(nameLen + 1)}`
}

spm
    .name("spm")
    .description(`Slim Package Manager (SPM ${pkg.version})`)
    .version(pkg.version);

spm
    .command("list")
	.action(() => {
		const targetDir = path.join(rootPath, "packages")
		if (!fs.existsSync(targetDir)) {
			spmlog("No packages installed (the packages/ directory does not exist)")
			return
		}

		const relativePaths = fs.readdirSync(targetDir);

		if (relativePaths.length === 0) {
			spmlog("No packages installed")
			return
		}

		function getPkgPath(pkg) {
			const relative = path.relative(process.cwd(), path.join(targetDir, pkg))
			return relative
		}

		spmlog(`List of all installed packages:\n${relativePaths.map(item => "- @" + item + ` (${getPkgPath(item)})`).join(",\n")}`)
	});

spm
    .command("get")
    .argument("<name>")
    .action(async (name) => {
        let msg = null;

        if (isPackageExists(name)) {
            const spmFileContent = await getSPM(name);

            if (!spmFileContent.success) {
                errlog(spmFileContent.content);
                return;
            }

			const SPMContent = spmFileContent.content;
			const packageName = "@" + name

			msg = renderBlock({
				name: packageName,
				content: renderObject(SPMContent)
			})
        } else {
            msg =
                formatError(`@${name} not installed\n`) +
                `Want to install? Try ${formatItalic(`${spm.name()} i ${name}`)}`;
        }

        spmlog(msg);
    });

spm
    .command("rm")
	.argument('<name>')
	.option("--g", "Removes the project from the project registry and GitHub")
	.action(async (name, opt) => {
		await loading({
			startMsg: `Removing @${name}...`,
			callback: async ({ fail, ok }) => {
				const isGlobally = opt.g == undefined ? false : true

				if (isGlobally) {
					const spmFileContent = await getSPM(name);

					if (!spmFileContent.success) {
						return fail("SPM Check:", spmFileContent.content);
					}

					const SPMContent = spmFileContent.content;
					const githubRepo = SPMContent.github.repo

					const githubToken = await getGitHubToken()

					// registry remove
					const removePackageRegReq = await removePackage({
						token: githubToken,
						name: name
					})

					if (!removePackageRegReq.success) {
						return fail("SPM Registry remove:", removePackageRegReq.content)
					}

					// github remove
					const removeFromGithubReq = await deleteGitHubRepo(githubToken, githubRepo)

					if (!removeFromGithubReq.success) {
						return fail(`${githubRepo} failed to remove from Github`)
					}
					else {
						return ok(`${githubRepo} removed from Github and registry`)
					}
				}

				const res = await deleteDirectory(path.join(rootPath, "packages", name))

				if (res) {
					return ok(`package @${name} successfully removed locally`)
				}
				else {
					return fail(`Failed to remove the @${name} package`)
				}
			}
		})
	});

spm
    .command("i")
	.argument('<name>')
    .option("--ver <version>", "Download a specific version")
	.action(async (name, opt) => {
		await loading({
			startMsg: `Installing @${name}...`,
			callback: async ({ fail, ok }) => {
				const getPackageReq = await getPackage({ name: name })

				if (!getPackageReq.success) {
					return fail("SPM Install:", getPackageReq.content)
				}
				else {
					const githubToken = await getGitHubToken()
					const data = getPackageReq.content

					const repo = data.repo
					const version = opt.ver == undefined ? data.latest : opt.ver

					console.log(`\nDownloading ${repo}...`)

					const downloadRepoReq = await downloadGitHubRepo(githubToken, repo, path.join(packagesPath, name), opt.ver)

					if (!downloadRepoReq.success) {
						return fail(downloadRepoReq.msg)
					}
					else {
						return ok(`Package @${name}:${version} installed`)
					}
				}
			}
		})
	});

spm
    .command("create")
	.argument("<name>")

	.option("--github", "Create repository on Github")
	.option("--local", "Create minimum package template in packages")

	.option("--github-repo <repoName>", "Fill in '@github/repo' in the configuration")
	.option("--description <description>", "Fill in 'description' in the configuration")
	.option("--ver <version>", "Fill in 'version' in the configuration")

	.action(async (name, opt) => {
		const defaultGithubRepo = opt.githubRepo == undefined ? "username/repo" : opt.githubRepo
		const defaultDescription = opt.description == undefined ? "My first Slim package" : opt.description
		const defaultVersion = opt.ver == undefined ? "1.0.0" : opt.ver

		if (opt.local) {
			const isExists = isPackageExists(name)

			await loading({
				startMsg: `Creating path for ${name}`,
				callback: async ({ fail, ok }) => {
					const packagePath = path.join(rootPath, "packages", name)

					if (isExists) return fail("Package is already exists")
					else {
						const createFolderReq = await createFolder(packagePath)

						if (!createFolderReq.success) {
							return fail(createFolderReq.content)
						}
						else {
							const createSPMReq = createFile(path.join(packagePath, ".spm"), `
							name = "${name}"
							description = "${defaultDescription}"
							version = "${defaultVersion}"

							@ github
								repo = "${defaultGithubRepo}"
							`.trim())

							if (!createSPMReq.success) {
								return fail(createSPMReq.content)
							}
							else {
								return ok("Local package created")
							}
						}
					}
				}
			})
		}
		else if (opt.github || opt.githubRepo) {
			const spmFileContent = await getSPM(name);

			if (!spmFileContent.success) {
				spmlog(formatError(spmFileContent.content));
				return;
			}

			const SPMContent = spmFileContent.content;
			const packageName = "@" + name;
			const githubRepo = SPMContent.github.repo

			await loading({
				startMsg: `Creating repository for ${packageName}`,
				callback: async ({ fail, ok }) => {
					const githubToken = await getGitHubToken();

					const createRepoReq = await createGitHubRepo(githubToken, githubRepo)

					if (!createRepoReq.success) {
						return fail(createRepoReq.msg)
					}
					else {
						return ok(createRepoReq.msg)
					}
				},
			})
		}
	})

spm
    .command("publish")
	.argument('<name>')
	.action(async (name) => {
		if (isPackageExists(name)) {
			const spmFileContent = await getSPM(name);

			if (!spmFileContent.success) {
				spmlog(formatError(spmFileContent.content));
				return;
			}

			const SPMContent = spmFileContent.content;
			const packageName = "@" + name;

			const githubRepo = SPMContent.github.repo
			const version = SPMContent.version
			const description = SPMContent.description
			const packagePath = path.join("packages", name)

			if ("github" in SPMContent && "repo" in SPMContent.github) {
				await loading({
					startMsg: `Publishing ${packageName}`,
					callback: async ({ fail, ok }) => {
						const githubToken = await getGitHubToken()

						const installationsReq = await fetch(
							"https://api.github.com/user/installations",
							{
								headers: githubHeaders(githubToken),
							},
						);

						const installations = await installationsReq.json()

						if ("total_count" in installations) {
							if (installations.total_count == 0) {
								await open(
									"https://github.com/apps/slim-package-manager/installations/new",
								);

								console.log("\n")
								spmlog(formatError(`No application has been installed on the "${githubRepo}" repository\n`))
								spmlog("Open:", formatBold.underline("https://github.com/apps/slim-package-manager/installations/new"))
								spmlog("Press Enter after installation...\n")

								return fail(`No application has been installed on the "${githubRepo}" repository`)
							}
							else {
								const githubPublishReq = await publishToGitHub({
									token: githubToken,
									repo: githubRepo,
									contentPath: packagePath
								})

								const packageInfoReq = await getPackage({
									name: name
								})

								if (!githubPublishReq.success) {
									return fail("Github publish:", githubPublishReq.msg)
								}
								else {
									const isPackagesExists = packageInfoReq.success

									if (isPackagesExists) {
										// updating SPM Registry
										console.log("\nPackage is already exists... updating")

										const updatePackageReq = await updatePackage({
											token: githubToken,
											name: name,
											description: description,
											version: version,
											github: githubRepo
										})

										if (!updatePackageReq.success) {
											return fail("Something went wrong while requesting a package update. Please try again later")
										}
										else {
											// updating github repo
											console.log("\nUpdating package on Github...")

											const updateReq = await updateGitHubRepo({
												token: githubToken,
												repo: githubRepo,
												packagePath: packagePath,
												version: updatePackageReq.content.latest
											})

											if (!updateReq.success) {
												return fail("Failed to push the new version to GitHub")
											}
											else {
												const publishedVer = updateReq.version
												return ok(`@${name} ${publishedVer} published on Github`)
											}
										}
									}
									else {
										// publish package to SPM Registry
										const publishReq = await publishPackage({
											token: githubToken,
											name: name,
											version: version,
											github: githubRepo,
											description: description
										})

										if (!publishReq.success) {
											return fail("SPM Registry publishing:", publishReq.content)
										}
										else {
											return ok(`${packageName} published and registred: ${name} v${version}`)
										}
									}
								}
							}
						}
						else {
							return fail("Installations:", installations.message)
						}
					}
				})
			}
			else {
				spmlog(formatError("No GitHub repository specified"));
			}
		} else {
			spmlog(formatError(`No package founded: /packages/${name}`));
		}
	});

spm
    .command("login")
	.description("Connect your GitHub account")
	.option("--check", "Check if you logged in")
	.action(async (opt) => {
		if (opt.check) {
			const token = await getGitHubToken()

			if (token) {
				try {
					const user = await getGitHubUser(token)

					spmlog(formatSuccess("Github connected"))
					spmlog(`${formatBold("Account")}: ${user.name} (${user.html_url})`)
				}
				catch (e) {
					spmlog(formatError(String(e)))
				}
			}
			else {
				spmlog(formatError(`Github NOT connected. Use ${formatItalic.underline(spm.name() + " login")} to login via Github`))
			}
		}
		else {
			await loading({
				startMsg: `Waiting for GitHub authorization...`,
				callback: async () => {
					try {
			            const token = await loginGitHub();
						await saveGitHubToken(token)

						return {
							success: true,
							msg: "Github account connected"
						}
			        }
					catch (error) {
						return {
							success: false,
							msg:`${error.message}`
						}
			        }
				}
			})
		}
    });

spm
    .command("logout")
    .description("Disconnect GitHub account")
    .action(async () => {
        try {
            await deleteGitHubToken();

            spmlog(formatSuccess("GitHub account disconnected"));
        } catch (error) {
        	spmlog(formatError(`✗ ${error.message}`));
            process.exitCode = 1;
        }
    });

try {
    spm.parse();
}
catch (err) {
    spmlog(formatError(err?.message ?? String(err)))
    process.exitCode = 1
}
