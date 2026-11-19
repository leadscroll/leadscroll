import { Button } from '@/components/ui/Button';
import { downloadFile } from '@/lib/download';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

const exportPath = (search: string, tagFilter: string): string => {
  const parameters = new URLSearchParams();
  if (search) {
    parameters.set('query', search);
  }

  if (tagFilter.startsWith('tag:')) {
    parameters.set('tag', tagFilter.slice(4));
  } else if (tagFilter.startsWith('group:')) {
    parameters.set('tagScope', tagFilter.slice(6));
  }

  const query = parameters.toString();
  return query ? `/v1/leads/export?${query}` : '/v1/leads/export';
};

/**
 * Downloads the current filtered lead list. The server resolves the custom
 * columns and streams the CSV; this component only owns the browser download.
 */
export const ExportLeadsButton = ({
  search,
  tagFilter,
}: {
  readonly search: string;
  readonly tagFilter: string;
}) => {
  const [pending, setPending] = useState(false);

  const exportCsv = async (): Promise<void> => {
    setPending(true);
    try {
      await downloadFile(
        exportPath(search, tagFilter),
        `leads-${new Date().toISOString().slice(0, 10)}.csv`,
        'text/csv',
      );
      toast.success('Leads exported');
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'The export failed.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      aria-label="Export filtered leads as CSV"
      disabled={pending}
      onClick={() => {
        void exportCsv();
      }}
      tone="secondary"
    >
      <Download size={15} />
      {pending ? 'Exporting…' : 'Export CSV'}
    </Button>
  );
};
