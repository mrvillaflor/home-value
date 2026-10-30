/*
 * Ask GitHub Actions to run lookup.yml once.
 * A 204 from the dispatches API means the run was queued.
 */

async function dispatchGitHubWorkflow({
  token,
  repo,
  workflow,
  ref = "main",
  inputs,
  fetchImpl = fetch,
}) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set.");
  }
  if (!repo || !workflow) {
    throw new Error("GITHUB_REPO and GITHUB_WORKFLOW are required.");
  }

  const url = "https://api.github.com/repos/" + repo + "/actions/workflows/" + workflow + "/dispatches";
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "home-value-api",
    },
    body: JSON.stringify({ ref, inputs }),
  });

  if (response.status !== 204) {
    const error = new Error("GitHub did not start the lookup.");
    error.status = response.status;
    throw error;
  }
  return response;
}

module.exports = { dispatchGitHubWorkflow };
