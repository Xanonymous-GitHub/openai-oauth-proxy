export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex authentication</title>
</head>
<body>
  <main>
    <h1>Codex authentication</h1>
    <p id="status" role="status" aria-live="polite">Checking account...</p>
    <dl>
      <dt>Email</dt><dd id="email">-</dd>
      <dt>Plan</dt><dd id="plan">-</dd>
      <dt>Device URL</dt><dd id="verification-url">-</dd>
      <dt>Device code</dt><dd><code id="user-code">-</code></dd>
    </dl>
    <form id="login-form"><button type="submit">Start device login</button></form>
    <button id="refresh" type="button">Refresh</button>
    <button id="cancel" type="button">Cancel login</button>
    <button id="logout" type="button">Log out</button>
  </main>
  <script src="/app.js" defer></script>
</body>
</html>
`;

export const ADMIN_SCRIPT = `"use strict";
let csrfToken = "";

const fields = {
  status: document.getElementById("status"),
  email: document.getElementById("email"),
  plan: document.getElementById("plan"),
  verificationUrl: document.getElementById("verification-url"),
  userCode: document.getElementById("user-code"),
};

function render(state) {
  fields.status.textContent = state.type;
  fields.email.textContent = state.type === "ready" && state.email ? state.email : "-";
  fields.plan.textContent = state.type === "ready" ? state.planType : "-";
  fields.verificationUrl.textContent = state.type === "login_pending" ? state.verificationUrl : "-";
  fields.userCode.textContent = state.type === "login_pending" ? state.userCode : "-";
}

async function request(path, body) {
  const options = body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify(body),
  };
  const response = await fetch(path, options);
  const result = await response.json();
  if (result.csrfToken) csrfToken = result.csrfToken;
  render(result.state);
}

document.getElementById("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void request("/api/login", { type: "chatgptDeviceCode" });
});
document.getElementById("refresh").addEventListener("click", () => void request("/api/refresh", {}));
document.getElementById("cancel").addEventListener("click", () => void request("/api/cancel", {}));
document.getElementById("logout").addEventListener("click", () => void request("/api/logout", {}));
void request("/api/state");
`;
