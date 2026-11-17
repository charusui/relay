import { ArrowLeft, FileText } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { readDoc } from '@/lib/docs';

export const dynamic = 'force-dynamic';

type Params = Promise<{ folder: string; name: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { folder, name } = await params;
  return { title: readDoc(folder, name)?.title ?? 'Write-up' };
}

export default async function DocPage({ params }: { params: Params }) {
  const { folder, name } = await params;
  const doc = readDoc(folder, name);
  if (!doc) notFound();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" className="size-8 shrink-0" aria-label="Back to evals">
          <Link href="/evals">
            <ArrowLeft />
          </Link>
        </Button>
        <p className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <FileText className="size-3.5" />
          {doc.source}
        </p>
      </div>
      <Card className="shadow-none">
        <CardContent className="px-6 py-2 md:px-10 md:py-4">
          <h1 className="text-2xl font-semibold tracking-tight">{doc.title}</h1>
          <article className="doc-prose mt-4" dangerouslySetInnerHTML={{ __html: doc.html }} />
        </CardContent>
      </Card>
    </div>
  );
}
