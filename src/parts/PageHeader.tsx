// Page header (spec #480, "Parts"): the page's one Title, after a back button whose name says where it goes. The
// button goes back in history, and to the page's parent when no entry of the app lies behind (the page was opened
// by a link): src/navigation.ts decides, and names the place it lands on.
import { useAddress } from "../navigation";
import type { ReactNode } from "react";
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
  /** An info mark (Tooltip's InfoMark) after the Title. */
  info?: ReactNode;
  /** A name for a page the generic names do not cover (a book's title, a series' name). */
  named?: (route: Route) => string | null | undefined;
  /** A page beside a list on a desktop (a Settings page, #614) is named by a level-2 heading under the list's Title. */
  level?: 1 | 2;
  /** The heading's id, for a section the heading names. */
  titleId?: string;
};

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

export function PageHeader({ title, back = false, parent, named, info, level = 1, titleId }: PageHeaderProps) {
  const address = useAddress();
  const Heading = level === 2 ? "h2" : "h1";
  return (
    <header className="part-page-header">
      {back && (
        <Button kind="secondary" icon={<BackIcon />} label={backName(address.backTarget(parent), named)} onClick={() => address.goBack(parent)} />
      )}
      <Heading id={titleId} className="part-page-title type-title">
        {title}
      </Heading>
      {info}
    </header>
  );
}
