import './globals.css';
import { CPSProvider } from '../context/CPSContext';
import { getActiveAcsmConfig } from '../lib/acsm/config';

const activeAcsm = getActiveAcsmConfig();

export const metadata = {
  title: activeAcsm.code,
  description: `${activeAcsm.name} Platform`,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <CPSProvider>
          {children}
        </CPSProvider>
      </body>
    </html>
  );
}
