import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Wayfinder',
  description: 'Indoor wayfinding for UMass Boston',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The map is pannable and zoomable on its own; pinch-zooming the page on top
  // of that just fights the user.
  maximumScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
