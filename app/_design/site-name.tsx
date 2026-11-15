import { Fragment } from "react";

/** A site name with a break opportunity after each dot. */
export function SiteNameText({ name }: { name: string }) {
  return (
    <>
      {name.split(".").map((label, index) => (
        <Fragment key={index}>{index > 0 && <>.<wbr /></>}{label}</Fragment>
      ))}
    </>
  );
}
