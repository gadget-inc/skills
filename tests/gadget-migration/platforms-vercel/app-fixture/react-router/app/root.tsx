import { Outlet, Scripts } from "react-router";

export default function App() {
  return (
    <html lang="en">
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
