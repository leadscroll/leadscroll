import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { type ReactNode } from 'react';

export const Dialog = ({
  children,
  description,
  onOpenChange,
  open,
  title,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly title: string;
}) => (
  <BaseDialog.Root
    onOpenChange={onOpenChange}
    open={open}
  >
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="dialog-backdrop" />
      <BaseDialog.Popup className="dialog-popup">
        <div className="dialog-heading">
          <div>
            <BaseDialog.Title className="dialog-title">
              {title}
            </BaseDialog.Title>
            {description && (
              <BaseDialog.Description className="dialog-description">
                {description}
              </BaseDialog.Description>
            )}
          </div>
          <BaseDialog.Close
            aria-label="Close dialog"
            className="icon-button"
          >
            <X size={17} />
          </BaseDialog.Close>
        </div>
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>
);
