import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import {
  Bell,
  Check,
  CircleAlert,
  Info,
  LoaderCircle,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';

const success = () =>
  toast.success('Lead saved', {
    description: 'Your changes are up to date.',
    duration: 8_000,
  });
const error = () =>
  toast.error('Couldn’t save changes', {
    description: 'Please try again. Your edits are still here.',
    duration: 10_000,
  });
const info = () =>
  toast.info('Tags updated', {
    description: 'fall26:closed replaced fall26:considering.',
    duration: 8_000,
  });
const loading = () =>
  toast.promise(
    new Promise<void>((resolve) => {
      setTimeout(resolve, 1_800);
    }),
    {
      error: 'Couldn’t save changes',
      loading: 'Saving lead…',
      success: 'Lead saved',
    },
  );
const undo = () =>
  toast('Tag removed', {
    action: { label: 'Undo', onClick: () => toast.success('Tag restored') },
    description: 'vip was removed from this lead.',
    duration: 8_000,
  });
const examples = [
  {
    action: success,
    description: 'A brief confirmation after a completed action.',
    icon: Check,
    label: 'Success',
  },
  {
    action: error,
    description: 'An error stays visible longer and tells you what to do next.',
    icon: CircleAlert,
    label: 'Error',
  },
  {
    action: info,
    description: 'Useful context when a selection changes another tag.',
    icon: Info,
    label: 'Information',
  },
  {
    action: loading,
    description: 'A saving indicator becomes a confirmation when finished.',
    icon: LoaderCircle,
    label: 'Loading → success',
  },
  {
    action: undo,
    description: 'A small action button for a reversible change.',
    icon: Undo2,
    label: 'With undo',
  },
];

export const ToastPreview = () => (
  <>
    <PageHeader
      action={
        <Button
          onClick={() => {
            toast.dismiss();
            success();
            error();
            info();
          }}
        >
          Show examples
        </Button>
      }
      eyebrow="Design preview"
      title="Notifications"
    />
    <div className="toast-preview-page">
      <div className="tags-intro">
        <span className="tags-page-icon">
          <Bell size={22} />
        </span>
        <div>
          <h2>Small updates, without breaking your flow</h2>
          <p>
            Tinted surfaces, a soft glow, and a short message. Try each
            notification below.
          </p>
        </div>
      </div>
      <div className="toast-preview-examples">
        {examples.map((example) => {
          const Icon = example.icon;
          return (
            <div
              className="toast-preview-example"
              key={example.label}
            >
              <Icon
                aria-hidden="true"
                size={17}
              />
              <div>
                <h3>{example.label}</h3>
                <p>{example.description}</p>
              </div>
              <Button
                onClick={() => {
                  toast.dismiss();
                  example.action();
                }}
                tone="secondary"
              >
                Show {example.label.toLowerCase()}
              </Button>
            </div>
          );
        })}
      </div>
      <div className="toast-preview-footer">
        <p>
          Notifications appear at the bottom right. Hover over a stack to expand
          it and pause dismissal.
        </p>
        <Button
          onClick={() => toast.dismiss()}
          tone="ghost"
        >
          Dismiss all
        </Button>
      </div>
      <p className="tags-preview-note">
        These examples only show notifications. They do not change any leads or
        tags.
      </p>
    </div>
  </>
);
