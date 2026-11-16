// Page header (spec #480, "Parts"): the page's one Title, after a back button whose name says where it goes. The
// button goes back in history, and to the page's parent when no entry of the app lies behind (the page was opened
// by a link): src/navigation.ts decides, and names the place it lands on.
import { useAddress } from "../navigation";
import type { Route } from "../routes";
import { Button } from "./Button";
import { backName } from "./back-name";
import "./page-header.css";

export type PageHeaderProps = {
  /** The page's Title; one per page. */
  title: string;
  /** Show the back button (a place's first page has none). */
  back?: boolean;
  /** Where the button goes when no entry of the app lies behind; the page's parent by default. */
  parent?: Route;
  /** A name for a page the generic names do not cover (a book's title, a series' name). */
  named?: (route: Route) => string | null | undefined;
};

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

export function PageHeader({ title, back = false, parent, named }: PageHeaderProps) {
  const address = useAddress();
  return (
    <header className="part-page-header">
      {back && (
        <Button kind="secondary" icon={<BackIcon />} label={backName(address.backTarget(parent), named)} onClick={() => address.goBack(parent)} />
      )}
      <h1 className="part-page-title type-title">{title}</h1>
    </header>
  );
}
