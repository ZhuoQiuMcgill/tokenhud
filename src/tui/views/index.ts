import type { ViewId } from "../vm/types.ts";
import { accounts } from "./accounts.tsx";
import { history } from "./history.tsx";
import { models } from "./models.tsx";
import { overview } from "./overview.tsx";
import type { View } from "./types.ts";

/** The four views in tab order. T11–T13 replace the placeholders one by one. */
// biome-ignore lint/suspicious/noExplicitAny: each view has its own model and state types.
export type AnyView = View<any, any>;

export const VIEWS: Readonly<Record<ViewId, AnyView>> = { overview, history, models, accounts };
