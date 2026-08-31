/**
 * HTML fixtures for the `structured` extractor. Kept as strings rather than
 * .html files because each one is a single ugly case the suite names, and a
 * reader judging the assertion wants the markup in the same file.
 */

/** A shop page that publishes everything at once: three well-formed JSON-LD
 * blocks (one a @graph container holding another @graph) plus a malformed
 * fourth, nested microdata, RDFa, an OG/Twitter pair whose image is
 * root-relative, and the full SEO set. Its OG title disagrees with its
 * JSON-LD name deliberately — nothing here reconciles the two. */
export const richProductHtml = `<!doctype html>
<html lang="en">
  <head>
    <title>Cast-Iron Skillet | Pans Co</title>
    <link rel="canonical" href="/skillet" />
    <link rel="alternate" hreflang="de" href="/de/skillet" />
    <link rel="alternate" hreflang="x-default" href="/skillet" />
    <link rel="alternate" type="application/rss+xml" title="New arrivals" href="/feed.xml" />
    <link rel="alternate" type="application/atom+xml" href="/atom.xml" />
    <link rel="alternate" type="application/json" href="/api/skillet.json" />
    <meta name="robots" content="index, FOLLOW, max-snippet:-1" />
    <meta name="robots" content="noarchive, index" />
    <meta property="og:title" content="Cast-Iron Skillet, 12 inch" />
    <meta property="og:description" content="Pre-seasoned, oven-safe." />
    <meta property="og:image" content="/img/skillet.jpg" />
    <meta property="og:type" content="product" />
    <meta property="og:site_name" content="Pans Co" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="Skillet, per Twitter" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "12-inch Cast-Iron Skillet",
        "offers": { "@type": "Offer", "price": "39.00", "priceCurrency": "USD" }
      }
    </script>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", "name": "Pans Co" },
          { "@graph": [{ "@type": "WebPage", "name": "Skillet page" }] }
        ]
      }
    </script>
    <script type="application/ld+json">
      { "@type": "Review", oops
    </script>
    <script type="application/ld+json; charset=utf-8">
      [{ "@type": "BreadcrumbList", "itemListElement": [] }]
    </script>
  </head>
  <body>
    <div itemscope itemtype="https://schema.org/Product" itemid="#skillet">
      <h1 itemprop="name">12-inch Cast-Iron Skillet</h1>
      <a itemprop="url" href="/skillet">permalink</a>
      <meta itemprop="sku" content="SK-12" />
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
        <span itemprop="price">39.00</span>
        <meta itemprop="priceCurrency" content="USD" />
        <time itemprop="priceValidUntil" datetime="2026-12-31">end of year</time>
      </div>
      <span itemprop="category">Cookware</span>
      <span itemprop="category">Cast iron</span>
    </div>
    <div vocab="https://schema.org/" typeof="Organization">
      <span property="name">Pans Co</span>
      <a property="url" href="/about">about us</a>
      <div property="address" typeof="PostalAddress" resource="#hq">
        <span property="addressLocality">Portland</span>
      </div>
    </div>
  </body>
</html>`;

/** JSON-LD blocks that parse but declare nothing, sit empty, or wrap their own
 * declarations around a @graph. All four shapes occur in the wild. */
export const jsonLdOddBlocksHtml = `<!doctype html>
<html>
  <head>
    <script type="application/ld+json">"just a string"</script>
    <script type="application/ld+json"></script>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "url": "https://example.com",
        "@graph": [{ "@type": "SearchAction" }]
      }
    </script>
    <script type="text/javascript">
      window.dataLayer = [{ "@type": "NotJsonLd" }];
    </script>
  </head>
  <body></body>
</html>`;

/** Twitter card with no Open Graph at all, and a <base> the relative image has
 * to resolve against rather than the page url. */
export const twitterOnlyHtml = `<!doctype html>
<html>
  <head>
    <base href="https://cdn.example.com/site/" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="A Post" />
    <meta name="twitter:description" content="Short one." />
    <meta name="twitter:image:src" content="thumb.png" />
    <meta name="twitter:site" content="@example" />
  </head>
  <body></body>
</html>`;

/** Open Graph published under name= instead of property=, which is common
 * enough that honouring only the correct spelling loses the preview. */
export const misspelledOgHtml = `<!doctype html>
<html>
  <head>
    <meta name="og:title" content="Under name=" />
    <meta name="og:image" content="https://example.com/a.png" />
  </head>
  <body></body>
</html>`;

/** A page that declares nothing structured whatsoever. */
export const bareHtml = `<!doctype html>
<html>
  <head>
    <title>Nothing here</title>
  </head>
  <body>
    <h1>Hello</h1>
    <p>Plain prose, no markup worth reporting.</p>
  </body>
</html>`;
