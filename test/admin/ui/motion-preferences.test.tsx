// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { badgeVariants } from "../../../src/admin/ui/components/ui/badge.js";
import { buttonVariants } from "../../../src/admin/ui/components/ui/button.js";
import { Skeleton } from "../../../src/admin/ui/components/ui/skeleton.js";

afterEach(cleanup);

it("keeps primitive motion behind reduced-motion preferences", () => {
  const buttonClasses = buttonVariants().split(" ");
  expect(buttonClasses).not.toContain("transition-all");
  expect(badgeVariants()).not.toContain("transition-");

  render(<Skeleton data-testid="skeleton" />);
  const skeletonClasses = screen.getByTestId("skeleton").className.split(" ");
  expect(skeletonClasses).toContain("motion-safe:animate-pulse");
  expect(skeletonClasses).not.toContain("animate-pulse");
});
