'use client';

import { RotateCcw, ServerCrash } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
      <ServerCrash className="size-8 text-muted-foreground" />
      <h1 className="text-lg font-semibold">This page couldn&apos;t load</h1>
      <p className="text-sm text-muted-foreground">
        The data behind it didn&apos;t come back. That&apos;s usually the database waking up after being idle; trying again normally works.
      </p>
      {error.digest && <p className="font-mono text-xs text-muted-foreground">Error ID {error.digest}</p>}
      <Button variant="outline" size="sm" onClick={reset}>
        <RotateCcw /> Try again
      </Button>
    </div>
  );
}
