export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: "invalid url" });
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });

    if (!response.ok) {
      return res.status(200).json(fallback(url, parsedUrl));
    }

    const html = await response.text();

    const meta = (prop) => {
      const a = html.match(
        new RegExp(
          `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']{1,500})["']`,
          "i"
        )
      );
      const b = html.match(
        new RegExp(
          `<meta[^>]+content=["']([^"']{1,500})["'][^>]+(?:property|name)=["']${prop}["']`,
          "i"
        )
      );
      return (a || b)?.[1]?.trim() ?? null;
    };

    const rawTitle =
      meta("og:title") ||
      meta("twitter:title") ||
      html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.trim() ||
      "";

    // Strip store suffixes like "| B&H Photo" or "- Amazon"
    const name = rawTitle.replace(/\s*[-|–—]\s*[^|–—]{1,60}$/, "").trim();

    const image =
      meta("og:image") || meta("twitter:image") || "";

    const priceRaw =
      meta("product:price:amount") ||
      meta("og:price:amount") ||
      meta("price") ||
      "";
    const price = priceRaw ? parseFloat(priceRaw.replace(/[^0-9.]/g, "")) || "" : "";

    // Guess retailer from hostname
    const host = parsedUrl.hostname.replace(/^www\./, "");
    const retailerMap = {
      "amazon.com": "Amazon",
      "bhphotovideo.com": "B&H Photo",
      "adorama.com": "Adorama",
      "bestbuy.com": "Best Buy",
      "keh.com": "KEH Camera",
      "mpb.com": "MPB",
      "ebay.com": "eBay",
      "walmart.com": "Walmart",
    };
    const retailer = retailerMap[host] || host;

    return res.status(200).json({ name, image, price, retailer, sourceUrl: url });
  } catch {
    return res.status(200).json(fallback(url, parsedUrl));
  }
}

function fallback(url, parsedUrl) {
  const host = parsedUrl.hostname.replace(/^www\./, "");
  const slug = parsedUrl.pathname
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/[-_]/g, " ")
    .replace(/\.[^.]+$/, "")
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "";
  return { name: slug, image: "", price: "", retailer: host, sourceUrl: url };
}
