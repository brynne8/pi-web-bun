// Picking a model from the selector: choosing the one already selected is a re-apply, not
// a change, and a pick made while the selector runs on automatic is always a change.

import type { ModelSelectorOption } from "@/components/ModelSelector";

export interface ChooseModelDeps {
  /** The model the session runs on now, if the page knows it. */
  value?: { provider: string; modelId: string } | null;
  /** True while the selector stands for pi's automatic choice, which any pick overrides. */
  isAutoSelection: boolean;
  onChange: (provider: string, modelId: string) => void;
  onReselect?: (provider: string, modelId: string) => void;
  setOpen: (open: boolean) => void;
  setFilter: (filter: string) => void;
}

export function chooseModel(option: ModelSelectorOption, deps: ChooseModelDeps): void {
  const active = option.modelId === deps.value?.modelId && option.provider === deps.value?.provider;
  deps.setOpen(false);
  deps.setFilter("");
  if (!active || deps.isAutoSelection) deps.onChange(option.provider, option.modelId);
  else deps.onReselect?.(option.provider, option.modelId);
}
