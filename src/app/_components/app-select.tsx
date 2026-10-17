"use client";

import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

type AppSelectProps<T extends string | number> = {
  ariaLabel: string;
  id?: string;
  compact?: boolean;
  disabled?: boolean;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  value: T;
};

export function AppSelect<T extends string | number>({ ariaLabel, id, compact = false, disabled, onChange, options, value }: AppSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  // The index is only the widget's key; callers retain their original typed values.
  const selectedIndex = options.findIndex((option) => option.value === value);
  return <Select.Root open={open} onOpenChange={setOpen} disabled={disabled || !options.length} value={selectedIndex < 0 ? "" : String(selectedIndex)} onValueChange={(index) => {
    const option = options[Number(index)];
    if (option) onChange(option.value);
  }}>
    <Select.Trigger id={id} className="cg-select" data-compact={compact} aria-label={`${ariaLabel}：${selected?.label ?? "无可选项"}`}>
      <Select.Value placeholder="无可选项" />
      <Select.Icon className="cg-select__icon"><ChevronDown aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <section aria-label={`${ariaLabel}选项`} hidden={!open}>
        <Select.Content className="cg-select__menu" data-compact={compact} aria-label={ariaLabel} position="popper" sideOffset={6} collisionPadding={12}>
          <Select.ScrollUpButton className="cg-select__scroll"><ChevronUp aria-hidden="true" /></Select.ScrollUpButton>
          <Select.Viewport className="cg-select__viewport">
            {options.map((option, index) => <Select.Item className="cg-select__option" value={String(index)} key={String(option.value)} textValue={option.label} tabIndex={index === Math.max(0, selectedIndex) ? 0 : -1}>
              <Select.ItemText>{option.label}</Select.ItemText>
              <Select.ItemIndicator className="cg-select__check"><Check aria-hidden="true" /></Select.ItemIndicator>
            </Select.Item>)}
          </Select.Viewport>
          <Select.ScrollDownButton className="cg-select__scroll"><ChevronDown aria-hidden="true" /></Select.ScrollDownButton>
        </Select.Content>
      </section>
    </Select.Portal>
  </Select.Root>;
}
