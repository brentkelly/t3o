/**
 * T3o (T3O-134): on a phone the card's rail is the Details sheet. Needs the app's CSS, since
 * the swap is media queries over one DOM.
 */
import "../index.css";

import { BOARD_SEED_STAGE_IDS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { baseProps, detail } from "./boardCardDetailFixtures";

// The real pane mounts a live chat; the sheet only needs the frame around it.
vi.mock(import("./BoardCardThreadPane"), () => ({
  BoardCardThreadPane: (() => <div>Thread pane</div>) as never,
}));

const { BoardCardDetailView } = await import("./BoardCardDetailView");

describe("the phone Details sheet (T3O-134)", () => {
  const sheet = () => page.getByRole("region", { name: "Card details", includeHidden: true });

  it("opens from the panel button over the full-screen card, and Escape closes the sheet first", async () => {
    await page.viewport(390, 844);
    const onClose = vi.fn();
    await using _screen = await render(
      <BoardCardDetailView
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.building })}
        detailsStatus="attention"
        onClose={onClose}
        projectName="P"
      />,
    );
    const button = page.getByRole("button", { name: "Details: Needs you" });
    await expect.element(button).toBeVisible();
    await expect.element(button).toHaveAttribute("aria-expanded", "false");
    await expect.element(sheet()).not.toBeVisible();

    await userEvent.click(button);
    await expect.element(sheet()).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();

    // A picker opened from the sheet takes the first Escape; the sheet stays.
    await userEvent.click(page.getByRole("button", { name: "Add labels" }));
    const search = page.getByPlaceholder("Search or create a label");
    await expect.element(search).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(search).not.toBeInTheDocument();
    await expect.element(sheet()).toBeVisible();

    // Escape with focus on the panel button closes the sheet, not the card.
    button.element().focus();
    await userEvent.keyboard("{Escape}");
    await expect.element(sheet()).not.toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops guarding Escape once a sheet opened on a phone is inline again", async () => {
    await page.viewport(390, 844);
    const onClose = vi.fn();
    await using _screen = await render(
      <BoardCardDetailView
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.building })}
        detailsStatus="attention"
        onClose={onClose}
        projectName="P"
      />,
    );
    const button = page.getByRole("button", { name: "Details: Needs you" });
    await userEvent.click(button);
    await expect.element(button).toHaveAttribute("aria-expanded", "true");

    await page.viewport(1280, 800);
    await expect.element(sheet()).toBeVisible();
    // Focus in the now-inline rail, where the guard used to claim Escape for a hidden sheet.
    const inRail = [...sheet().element().querySelectorAll<HTMLElement>("button")].find((b) =>
      b.checkVisibility(),
    );
    inRail?.focus();
    expect(document.activeElement).toBe(inRail);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    // The card closes and the sheet's own state is left for when the window narrows.
    expect(
      page
        .getByRole("button", { name: "Details: Needs you", includeHidden: true })
        .element()
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("leaves the rail inline at desktop width, with no panel button", async () => {
    await page.viewport(1280, 800);
    await using _screen = await render(
      <BoardCardDetailView
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.building })}
        detailsStatus="attention"
        projectName="P"
      />,
    );
    await expect.element(sheet()).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Details: Needs you", includeHidden: true }))
      .not.toBeVisible();
  });
});
