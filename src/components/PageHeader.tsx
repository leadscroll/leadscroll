import { ChevronRight } from 'lucide-react';

export const PageHeader = ({
  action,
  eyebrow,
  title,
}: {
  readonly action?: React.ReactNode;
  readonly eyebrow?: React.ReactNode;
  readonly title: string;
}) => (
  <header className="page-header">
    <div className="page-breadcrumb">
      {eyebrow && (
        <>
          <span className="breadcrumb-parent">{eyebrow}</span>
          <ChevronRight
            aria-hidden="true"
            size={13}
          />
        </>
      )}
      <h1>{title}</h1>
    </div>
    {action && <div className="page-actions">{action}</div>}
  </header>
);
