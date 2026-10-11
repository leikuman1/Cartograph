"use client";

import { useSyncExternalStore } from "react";

const storageKey = "cartograph-theme";
const changeEvent = "cartograph-theme-change";

function isTheme(value: string | null | undefined): value is "system" | "light" | "dark" {
  return value === "system" || value === "light" || value === "dark";
}

function subscribe(onChange: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key !== storageKey && event.key !== null) return;
    document.documentElement.dataset.theme = isTheme(event.newValue)
      ? event.newValue
      : "system";
    onChange();
  }

  window.addEventListener(changeEvent, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(changeEvent, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot() {
  const value = document.documentElement.dataset.theme;
  return isTheme(value) ? value : "system";
}

export default function ThemeControl() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => "system");

  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      Theme
      <select
        aria-label="Theme"
        value={theme}
        className="control"
        onChange={(event) => {
          const value = event.target.value;
          if (!isTheme(value)) return;
          document.documentElement.dataset.theme = value;
          try {
            localStorage.setItem(storageKey, value);
          } catch {
            // A restricted storage environment can still change the current theme.
          }
          window.dispatchEvent(new Event(changeEvent));
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
