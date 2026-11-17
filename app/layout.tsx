import type { Metadata } from 'next';
import Script from 'next/script';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Relay Monitoring',
  description: 'Live monitoring for Relay, a measured AI customer support agent: conversations, hand-offs, failures, reply time, tokens and alerts.',
  robots: { index: false },
};

// Applies the saved theme before paint, so there is no flash of the wrong theme.
const themeScript = `try{var t=localStorage.getItem('relay-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Script id="relay-theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
        {children}
      </body>
    </html>
  );
}
