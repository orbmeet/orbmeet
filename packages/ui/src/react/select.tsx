import { Select as BaseSelect } from "@base-ui/react/select";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { Check, ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import type { ComponentProps } from "react";

import { control, listbox } from "../styles/controls";

interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

/**
 * Everything the trigger accepts, minus the parts this wrapper composes itself.
 *
 * `name` and `form` are excluded deliberately: they are `<button>` attributes,
 * so they would type-check and then do nothing. Form participation belongs to
 * `Select.Root`, which is what renders the hidden input — they are re-declared
 * below and routed there.
 */
type TriggerProps = Omit<
  ComponentProps<typeof BaseSelect.Trigger>,
  "children" | "render" | "className" | "style" | "disabled" | "name" | "form"
>;

interface SelectProps extends TriggerProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
  options: SelectOption[];
  /** Identifies the field when the owning form is submitted. */
  name?: string;
  /** Id of the form the hidden input belongs to, when rendered outside it. */
  form?: string;
  /** Whether a value must be chosen before the owning form can be submitted. */
  required?: boolean;
  /** Whether the value is visible but not changeable. */
  readOnly?: boolean;
  /** Applied to the trigger — sizing a Select means sizing the control itself. */
  sx?: StyleXStyles;
  /**
   * Applied to the wrapper that `label` introduces. Without a label there is no
   * wrapper and the trigger is the only element the parent layout sees.
   */
  containerSx?: StyleXStyles;
  /**
   * Accessible name for the trigger when the visible label is rendered outside
   * this component (associate it via an id + aria-labelledby).
   */
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

export function Select({
  value,
  defaultValue,
  onValueChange,
  placeholder = "Select…",
  disabled,
  label,
  options,
  sx,
  containerSx,
  name,
  form,
  required,
  readOnly,
  ...triggerProps
}: SelectProps) {
  const trigger = (
    <BaseSelect.Trigger {...triggerProps} {...stylex.props(control.trigger, sx)}>
      <BaseSelect.Value placeholder={placeholder} {...stylex.props(control.value)} />
      <BaseSelect.Icon {...stylex.props(control.triggerIcon)}>
        <ChevronsUpDown size={16} />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );

  return (
    <BaseSelect.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      name={name}
      form={form}
      required={required}
      readOnly={readOnly}
      items={options}
    >
      {/* Select.Root renders no element of its own, so an unwrapped Label and
          Trigger would land in the parent layout as two separate children — the
          label would sit *beside* its control in any flex row or grid. The
          wrapper is what `Field.Root` gives `Input` for free. */}
      {label ? (
        <div {...stylex.props(control.field, containerSx)}>
          <BaseSelect.Label {...stylex.props(control.label)}>{label}</BaseSelect.Label>
          {trigger}
        </div>
      ) : (
        trigger
      )}

      <BaseSelect.Portal>
        {/* No side/align/offset: under the default `alignItemWithTrigger` mode
            the positioner aligns the selected item over the trigger and ignores
            them. */}
        <BaseSelect.Positioner {...stylex.props(listbox.positioner)}>
          <BaseSelect.Popup {...stylex.props(listbox.popup, listbox.anchorWidth)}>
            <BaseSelect.ScrollUpArrow {...stylex.props(listbox.scrollArrow)}>
              <ChevronUp size={12} />
            </BaseSelect.ScrollUpArrow>
            <BaseSelect.List {...stylex.props(listbox.list)}>
              {options.map(({ label: optLabel, value: optValue, disabled: optDisabled }) => (
                <BaseSelect.Item
                  key={optValue}
                  value={optValue}
                  disabled={optDisabled}
                  {...stylex.props(listbox.item)}
                >
                  <BaseSelect.ItemIndicator {...stylex.props(listbox.indicator)}>
                    <Check size={14} />
                  </BaseSelect.ItemIndicator>
                  <BaseSelect.ItemText {...stylex.props(listbox.itemText)}>
                    {optLabel}
                  </BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
            <BaseSelect.ScrollDownArrow {...stylex.props(listbox.scrollArrow)}>
              <ChevronDown size={12} />
            </BaseSelect.ScrollDownArrow>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

export type { SelectOption };
