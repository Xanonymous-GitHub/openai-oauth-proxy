import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type ThemeMode = "system" | "light" | "dark";
const STORAGE_KEY = "admin-theme";

const OPTIONS = [
  { mode: "system", label: "Use system theme", Icon: IconDeviceDesktop },
  { mode: "light", label: "Use light theme", Icon: IconSun },
  { mode: "dark", label: "Use dark theme", Icon: IconMoon },
] as const;

function storedMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function ThemeControl() {
  const [mode, setMode] = useState<ThemeMode>(storedMode);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        mode === "system" ? (media.matches ? "dark" : "light") : mode;
    };
    apply();
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Persistence is optional; the selected theme is already applied.
    }
    if (mode !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  return (
    <fieldset
      className="flex items-center rounded-md border bg-card p-0.5"
      aria-label="Color theme"
    >
      {OPTIONS.map(({ mode: option, label, Icon }) => (
        <Button
          key={option}
          type="button"
          size="icon"
          variant={mode === option ? "secondary" : "ghost"}
          className="size-8"
          aria-label={label}
          aria-pressed={mode === option}
          title={label}
          onClick={() => setMode(option)}
        >
          <Icon size={16} aria-hidden="true" />
        </Button>
      ))}
    </fieldset>
  );
}
