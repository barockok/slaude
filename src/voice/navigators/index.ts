import { genericNavigator, type Navigator } from "./navigator";
import { jitsiNavigator } from "./jitsi";
import { meetNavigator } from "./meet";

const NAVIGATORS: Navigator[] = [meetNavigator, jitsiNavigator];

/** Pick the navigator that claims this URL; unknown platforms get the
 *  generic open-the-page fallback (audio plumbing works regardless). */
export function resolveNavigator(url: string): Navigator {
  const u = new URL(url);
  return NAVIGATORS.find((n) => n.matches(u)) ?? genericNavigator;
}

export type { JoinOptions, Navigator } from "./navigator";
