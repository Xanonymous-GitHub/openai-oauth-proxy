// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeControl } from "../../../src/admin/ui/theme-control.js";

const values = new Map<string, string>();
const storage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => values.delete(key),
  setItem: (key, value) => values.set(key, value),
};

beforeEach(() => {
  vi.stubGlobal("localStorage", storage);
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("uses the system theme by default", () => {
  render(<ThemeControl />);
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(
    screen
      .getByRole("button", { name: "Use system theme" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

it("persists explicit light and dark modes", async () => {
  const user = userEvent.setup();
  render(<ThemeControl />);
  await user.click(screen.getByRole("button", { name: "Use light theme" }));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("admin-theme")).toBe("light");
  await user.click(screen.getByRole("button", { name: "Use dark theme" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("admin-theme")).toBe("dark");
});

it("restores a stored explicit mode on mount", () => {
  localStorage.setItem("admin-theme", "light");
  render(<ThemeControl />);

  expect(document.documentElement.dataset.theme).toBe("light");
  expect(
    screen
      .getByRole("button", { name: "Use light theme" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

it("exposes the theme modes in keyboard order", async () => {
  const user = userEvent.setup();
  render(<ThemeControl />);
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Use system theme" }),
  );
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Use light theme" }),
  );
});

it("tracks system theme changes while system mode is active", () => {
  let dark = false;
  let listener: (() => void) | undefined;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_type: string, next: () => void) => {
        listener = next;
      },
      removeEventListener: vi.fn(),
    })),
  );
  render(<ThemeControl />);
  expect(document.documentElement.dataset.theme).toBe("light");
  dark = true;
  listener?.();
  expect(document.documentElement.dataset.theme).toBe("dark");
});

it("removes the system listener when an explicit mode is selected", async () => {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener,
      removeEventListener,
    })),
  );
  const user = userEvent.setup();
  render(<ThemeControl />);
  const listener = addEventListener.mock.calls[0]?.[1];

  await user.click(screen.getByRole("button", { name: "Use dark theme" }));

  expect(removeEventListener).toHaveBeenCalledWith("change", listener);
});
