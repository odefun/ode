<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { cn } from "$lib/utils";

  // A simple two-state toggle that mirrors the shadcn/Radix "Switch" look.
  // Uses a real <button role="switch"> so it picks up keyboard + a11y for
  // free; consumers bind a boolean via `checked` and/or listen to the
  // `change` event (detail = next checked value).
  export let checked = false;
  export let disabled = false;
  export let className = "";
  export let id: string | undefined = undefined;
  export let ariaLabel: string | undefined = undefined;

  const dispatch = createEventDispatcher<{ change: boolean }>();

  function toggle(): void {
    if (disabled) return;
    checked = !checked;
    dispatch("change", checked);
  }
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={ariaLabel}
  {id}
  {disabled}
  class={cn(
    "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--background))]",
    "disabled:cursor-not-allowed disabled:opacity-50",
    checked
      ? "bg-[hsl(var(--primary))]"
      : "bg-[hsl(var(--muted))] border-[hsl(var(--border))]",
    className
  )}
  on:click={toggle}
>
  <span
    class={cn(
      "pointer-events-none block h-5 w-5 rounded-full bg-[hsl(var(--background))] shadow ring-0 transition-transform",
      checked ? "translate-x-5" : "translate-x-0"
    )}
  ></span>
</button>
