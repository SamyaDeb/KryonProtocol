/**
 * Swizzled @theme/Logo.
 *
 * The only change vs. the stock component: the brand (logo + KRYON wordmark)
 * links to the *site root* `/` via a plain <a>, not a Docusaurus <Link>.
 * The docs are served under the `/docs/` baseUrl, and both <Link> and
 * useBaseUrl keep navigation inside that prefix — so a normal internal link
 * would land on the docs home. A plain anchor to `/` performs a full
 * navigation out of the docs app and onto the Next.js landing page.
 */
import React from "react";
import useBaseUrl from "@docusaurus/useBaseUrl";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import { useThemeConfig } from "@docusaurus/theme-common";
import ThemedImage from "@theme/ThemedImage";
import type { Props } from "@theme/Logo";

function LogoThemedImage({ logo, alt, imageClassName }: any) {
  const sources = {
    light: useBaseUrl(logo.src),
    dark: useBaseUrl(logo.srcDark || logo.src),
  };
  const themedImage = (
    <ThemedImage
      className={logo.className}
      sources={sources}
      height={logo.height}
      width={logo.width}
      alt={alt}
      style={logo.style}
    />
  );
  return imageClassName ? (
    <div className={imageClassName}>{themedImage}</div>
  ) : (
    themedImage
  );
}

export default function Logo(props: Props): React.JSX.Element {
  const {
    siteConfig: { title },
  } = useDocusaurusContext();
  const {
    navbar: { title: navbarTitle, logo },
  } = useThemeConfig();
  const { imageClassName, titleClassName, ...propsRest } = props;
  // Always return to the landing page (site root), escaping the /docs/ baseUrl.
  const logoLink = (logo as any)?.href || "/";
  const fallbackAlt = navbarTitle ? "" : title;
  const alt = (logo as any)?.alt ?? fallbackAlt;
  return (
    <a href={logoLink} {...(propsRest as any)} {...((logo as any)?.target && { target: (logo as any).target })}>
      {logo && (
        <LogoThemedImage logo={logo} alt={alt} imageClassName={imageClassName} />
      )}
      {navbarTitle != null && <b className={titleClassName}>{navbarTitle}</b>}
    </a>
  );
}
