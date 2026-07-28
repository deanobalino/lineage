import * as Dialog from "@radix-ui/react-dialog";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { CloseIcon } from "./Icons.js";

export function Button({
  variant = "quiet",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "quiet" | "danger";
}) {
  return (
    <button
      className={`button button--${variant} ${className}`}
      type={props.type ?? "button"}
      {...props}
    />
  );
}

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = ""
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className={`sheet ${className}`}>
          <header className="sheet__header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description ? (
                <Dialog.Description>{description}</Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close">
                <CloseIcon />
              </IconButton>
            </Dialog.Close>
          </header>
          <div className="sheet__body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ErrorNotice({
  title = "Could not complete that request",
  message,
  retry
}: {
  title?: string;
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="notice notice--error" role="alert">
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      {retry ? <Button onClick={retry}>Try again</Button> : null}
    </div>
  );
}

export function LoadingRows({ count = 6 }: { count?: number }) {
  return (
    <div className="loading-rows" aria-label="Loading" aria-live="polite">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} style={{ width: `${52 + ((index * 17) % 42)}%` }} />
      ))}
    </div>
  );
}

