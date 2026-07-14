import { createAdminApp } from "/app/dist/admin/app.js";
import { SessionStore } from "/app/dist/admin/sessions.js";

const account = {
  state: () => ({ type: "signed_out" }),
  login: async () => ({ type: "signed_out" }),
  cancel: async () => undefined,
  refresh: async () => undefined,
  logout: async () => undefined,
};
const app = createAdminApp({
  account,
  sessions: new SessionStore(),
  allowedOrigins: new Set(["http://127.0.0.1:8081"]),
  assetRoot: "/app/dist/admin-ui",
});

for (const path of ["/", "/app.js", "/app.css", "/api/state"]) {
  const response = await app.request(path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
}
