// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApp } from "../../../src/admin/ui/admin-app.js";

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

function requestInit(
  fetchMock: ReturnType<typeof fetchSequence>,
  call: number,
) {
  return fetchMock.mock.calls[call]?.[1] as RequestInit;
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
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/refresh");
    expect(requestInit(fetchMock, 1).body).toBe("{}");
    expect(requestInit(fetchMock, 1).headers).toMatchObject({
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    });
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
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/login");
    expect(requestInit(fetchMock, 1).body).toBe(
      JSON.stringify({ type: "chatgptDeviceCode" }),
    );
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
    expect(requestInit(loginFetch, 2).headers).toMatchObject({
      "x-csrf-token": rotatedToken,
    });
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
    expect(requestInit(logoutFetch, 2).headers).toMatchObject({
      "x-csrf-token": rotatedToken,
    });
  });

  it("bootstraps once after 403 without replaying the mutation", async () => {
    const fetchMock = fetchSequence(
      response({
        type: "ready",
        email: "dev@example.com",
        planType: "plus",
      }),
      Response.json({ error: "forbidden" }, { status: 403 }),
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
