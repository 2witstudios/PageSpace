import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { FileQuestion, Home, ArrowLeft } from 'lucide-react';

export default function NotFoundPage() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-muted flex items-center justify-center">
            <FileQuestion className="w-6 h-6 text-muted-foreground" />
          </div>
          <CardTitle className="text-xl">Page not found</CardTitle>
          <CardDescription>
            The page you&apos;re looking for doesn&apos;t exist or has been
            moved.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="default" asChild className="w-full">
              <Link href="/dashboard">
                <Home className="w-4 h-4 mr-2" />
                Go to Dashboard
              </Link>
            </Button>

            <Button
              variant="outline"
              onClick={() => history.back()}
              className="w-full"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Go Back
            </Button>
          </div>

          <p className="text-center text-sm text-muted-foreground">
            If you believe this is an error, please{' '}
            <a
              href="https://github.com/2witstudios/PageSpace/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              report it
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
