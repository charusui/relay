import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="font-mono text-xs text-muted-foreground">404</p>
      <h1 className="text-lg font-semibold">Nothing here</h1>
      <p className="max-w-sm text-sm text-muted-foreground">That page or conversation doesn&apos;t exist. Evaluation conversations are kept out of the dashboard on purpose.</p>
      <Button asChild variant="outline" size="sm">
        <Link href="/">Back to overview</Link>
      </Button>
    </div>
  );
}
