import Script from "next/script";
import "antd/dist/reset.css";
import "../index.css";
import "../App.css";

export const metadata = {
  title: "Repository of Rips",
  description: "Card collection portfolio and spend tracking.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script
          src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"
          strategy="beforeInteractive"
        />
      </body>
    </html>
  );
}
