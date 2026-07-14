// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApp } from "../../../src/admin/ui/admin-app.js";

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const csrfToken = "c".repeat(43);
const rotatedToken = "d".repeat(43);
const response = (state: unknown, token = csrfToken, init?: ResponseInit) =>
  Response.json({ state, csrfToken: token }, init);

function fetchSequence(...items: Array<Response | Error | Promise<Response>>) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const item of items) {
    fetchMock.mockImplementationOnce(() =>
      item instanceof Error ? Promise.reject(item) : Promise.resolve(item),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function expectMutation(
  fetchMock: ReturnType<typeof fetchSequence>,
  call: number,
  path: string,
  body: object,
  token = csrfToken,
) {
  expect(fetchMock.mock.calls[call]).toEqual([
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": token,
      },
      body: JSON.stringify(body),
    },
  ]);
}

const pending = {
  type: "login_pending",
  loginId: "login-1",
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode: "ABCD-EFGH",
};

describe("AdminApp", () => {
  it("renders checking with a manual refresh action", async () => {
    const fetchMock = fetchSequence(
      response({ type: "checking" }),
      response({ type: "signed_out" }),
    );
    const user = userEvent.setup();
    render(<AdminApp />);

    await user.click(
      await screen.findByRole("button", { name: "Refresh status" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expectMutation(fetchMock, 1, "/api/refresh", {});
  });

  it("starts device login with the exact payload", async () => {
    const fetchMock = fetchSequence(
      response({ type: "signed_out" }),
      response(pending, rotatedToken),
    );
    const user = userEvent.setup();
    render(<AdminApp />);

    await user.click(
      await screen.findByRole("button", { name: "Connect Codex" }),
    );
    await screen.findByText("ABCD-EFGH");
    expectMutation(fetchMock, 1, "/api/login", { type: "chatgptDeviceCode" });
  });

  it("uses the authentication title as the page heading", async () => {
    fetchSequence(response({ type: "signed_out" }));
    render(<AdminApp />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Codex authentication",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "A focused path to authorization.",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Connect your Codex account",
      }),
    ).toBeTruthy();
  });

  it("renders ready details and a nullable-email fallback", async () => {
    fetchSequence(
      response({
        type: "ready",
        email: "dev@example.com",
        planType: "plus",
      }),
    );
    const first = render(<AdminApp />);
    expect(await screen.findByText("dev@example.com")).toBeTruthy();
    expect(screen.getByText("Plus")).toBeTruthy();
    first.unmount();

    fetchSequence(response({ type: "ready", email: null, planType: "team" }));
    render(<AdminApp />);
    expect(await screen.findByText("Email unavailable")).toBeTruthy();
    expect(screen.getByText("Team")).toBeTruthy();
  });

  it("copies the pending code, refreshes, and cancels", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const fetchMock = fetchSequence(
      response(pending),
      response(pending),
      response({ type: "signed_out" }),
    );
    render(<AdminApp />);

    await user.click(await screen.findByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("ABCD-EFGH");
    expect(screen.getByText("Copied")).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "Refresh status" });
    await user.click(refresh);
    await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(false));
    await user.click(screen.getByRole("button", { name: "Cancel login" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/state",
      "/api/refresh",
      "/api/cancel",
    ]);
    expectMutation(fetchMock, 1, "/api/refresh", {});
    expectMutation(fetchMock, 2, "/api/cancel", {});
  });

  it("links only the canonical OpenAI device URL", async () => {
    fetchSequence(response(pending));
    const first = render(<AdminApp />);
    const link = await screen.findByRole("link", {
      name: "Open verification page",
    });
    expect(link.getAttribute("href")).toBe(
      "https://auth.openai.com/codex/device",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    first.unmount();

    fetchSequence(
      response({
        ...pending,
        verificationUrl: "https://auth.openai.com.evil.example/codex/device",
      }),
    );
    const second = render(<AdminApp />);
    expect(
      await screen.findByText("Verification link unavailable"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Open verification page" }),
    ).toBeNull();
    second.unmount();
  });

  it.each([
    [
      "query string",
      "https://auth.openai.com/codex/device?redirect=https://evil.example",
    ],
    ["fragment", "https://auth.openai.com/codex/device#fragment"],
  ])("rejects the canonical device URL with a %s", async (_, verificationUrl) => {
    fetchSequence(response({ ...pending, verificationUrl }));
    render(<AdminApp />);
    expect(
      await screen.findByText("Verification link unavailable"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Open verification page" }),
    ).toBeNull();
  });

  it("reconnects from authentication error", async () => {
    const fetchMock = fetchSequence(
      response({ type: "error", code: "authentication_required" }),
      response(pending, rotatedToken),
    );
    const user = userEvent.setup();
    render(<AdminApp />);
    await user.click(
      await screen.findByRole("button", { name: "Reconnect Codex" }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/login");
  });

  it("disables mutation controls while a mutation is pending", async () => {
    let finish: ((value: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    fetchSequence(response({ type: "signed_out" }), pendingResponse);
    const user = userEvent.setup();
    render(<AdminApp />);
    const connect = await screen.findByRole("button", {
      name: "Connect Codex",
    });
    await user.click(connect);
    expect(connect.hasAttribute("disabled")).toBe(true);
    finish?.(response(pending, rotatedToken));
    await screen.findByText("ABCD-EFGH");
  });

  it("adopts rotated CSRF tokens after login and logout", async () => {
    const loginFetch = fetchSequence(
      response({ type: "signed_out" }),
      response(pending, rotatedToken),
      response(pending, rotatedToken),
    );
    const user = userEvent.setup();
    const first = render(<AdminApp />);
    await user.click(
      await screen.findByRole("button", { name: "Connect Codex" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Refresh status" }),
    );
    expectMutation(loginFetch, 2, "/api/refresh", {}, rotatedToken);
    first.unmount();

    const logoutFetch = fetchSequence(
      response({
        type: "ready",
        email: "dev@example.com",
        planType: "plus",
      }),
      response({ type: "signed_out" }, rotatedToken),
      response(pending, "e".repeat(43)),
    );
    render(<AdminApp />);
    await user.click(await screen.findByRole("button", { name: "Log out" }));
    await user.click(
      await screen.findByRole("button", { name: "Connect Codex" }),
    );
    expectMutation(logoutFetch, 1, "/api/logout", {});
    expectMutation(
      logoutFetch,
      2,
      "/api/login",
      { type: "chatgptDeviceCode" },
      rotatedToken,
    );
  });

  it.each([
    401, 403,
  ])("bootstraps once after %i without replaying the mutation", async (status) => {
    const fetchMock = fetchSequence(
      response({
        type: "ready",
        email: "dev@example.com",
        planType: "plus",
      }),
      Response.json({ error: "unauthorized" }, { status }),
      response({ type: "signed_out" }, rotatedToken),
    );
    const user = userEvent.setup();
    render(<AdminApp />);
    await user.click(
      await screen.findByRole("button", { name: "Refresh account" }),
    );
    await screen.findByRole("button", { name: "Connect Codex" });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/state",
      "/api/refresh",
      "/api/state",
    ]);
    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/refresh"),
    ).toHaveLength(1);
  });

  it("applies a valid 503 state and shows sanitized failure copy", async () => {
    fetchSequence(
      response({ type: "signed_out" }),
      response({ type: "error", code: "authentication_required" }, csrfToken, {
        status: 503,
      }),
    );
    const user = userEvent.setup();
    render(<AdminApp />);
    await user.click(
      await screen.findByRole("button", { name: "Connect Codex" }),
    );
    expect(
      await screen.findByText("Authentication is temporarily unavailable."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Reconnect Codex" }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("refresh-token");
  });

  it("preserves state and CSRF token after a valid-shaped 500 response", async () => {
    const fetchMock = fetchSequence(
      response({
        type: "ready",
        email: "dev@example.com",
        planType: "plus",
      }),
      response({ type: "signed_out" }, rotatedToken, { status: 500 }),
      response({
        type: "ready",
        email: "dev@example.com",
        planType: "plus",
      }),
    );
    const user = userEvent.setup();
    render(<AdminApp />);

    await user.click(
      await screen.findByRole("button", { name: "Refresh account" }),
    );
    expect(
      await screen.findByText("Session unavailable. Try again."),
    ).toBeTruthy();
    expect(screen.getByText("dev@example.com")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Refresh account" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expectMutation(fetchMock, 2, "/api/refresh", {}, csrfToken);
  });

  it("preserves the last valid state after malformed or failed responses", async () => {
    fetchSequence(
      response({
        type: "ready",
        email: "dev@example.com",
        planType: "plus",
      }),
      new Response("not json", { status: 500 }),
      new TypeError("network failed"),
    );
    const user = userEvent.setup();
    render(<AdminApp />);
    const refresh = await screen.findByRole("button", {
      name: "Refresh account",
    });
    await user.click(refresh);
    expect(
      await screen.findByText("Session unavailable. Try again."),
    ).toBeTruthy();
    expect(screen.getByText("dev@example.com")).toBeTruthy();
    await user.click(refresh);
    expect(screen.getByText("dev@example.com")).toBeTruthy();
  });

  it("shows session unavailable and retries a failed initial bootstrap", async () => {
    fetchSequence(
      new TypeError("network failed"),
      response({ type: "signed_out" }),
    );
    const user = userEvent.setup();
    render(<AdminApp />);
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: "Connect Codex" }),
    ).toBeTruthy();
  });
});
