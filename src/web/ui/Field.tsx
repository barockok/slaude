import {
  forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
} from "react";
import { cx } from "./cx";
import { IconChevronDown, IconSearch } from "./icons";

export interface FieldProps {
  label: string;
  /** Visually hide the label but keep it for assistive tech. */
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  /** Renders the control; receives the ids to wire up. */
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label, control, hint and error, wired with ids for assistive tech. */
export function Field({ label, hideLabel, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="sl-field">
      <label htmlFor={id} className={cx("sl-field__label", hideLabel && "sl-visually-hidden")}>
        {label}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {hint && !error && (
        <p id={hintId} className="sl-field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="sl-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "md" | "lg";
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = "md", invalid, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx("sl-input", `sl-input--${size}`, className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: "sm" | "md" | "lg";
  invalid?: boolean;
}

/** A native select, styled: keyboard and mobile pickers come for free. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = "md", invalid, className, children, ...rest },
  ref,
) {
  return (
    <span className={cx("sl-select", `sl-input--${size}`, className)}>
      <select ref={ref} aria-invalid={invalid || undefined} {...rest}>
        {children}
      </select>
      <IconChevronDown className="sl-select__chevron" size={16} />
    </span>
  );
});

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type"> {
  /** Accessible name when there is no visible label. */
  label: string;
  /** Keyboard hint shown at the end, e.g. ["Ctrl", "K"]. */
  shortcut?: string[];
  size?: "sm" | "md";
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { label, shortcut, size = "md", className, ...rest },
  ref,
) {
  return (
    <span className={cx("sl-search", `sl-search--${size}`, className)}>
      <IconSearch className="sl-search__icon" size={16} />
      <input ref={ref} type="search" aria-label={label} {...rest} />
      {shortcut && shortcut.length > 0 && (
        <span className="sl-search__keys" aria-hidden="true">
          {shortcut.map((k) => (
            <kbd key={k}>{k}</kbd>
          ))}
        </span>
      )}
    </span>
  );
});
