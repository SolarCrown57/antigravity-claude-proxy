/**
 * Search Engine Module
 * Provides web search capability for the proxy to handle web_search tool calls locally
 *
 * Supports multiple search providers:
 * - Serper.dev (Google Search API) - recommended
 * - Bing Web Search API
 * - DuckDuckGo HTML parsing (free, no API key needed)
 */

import { SEARCH_CONFIG } from '../constants.js';

/**
 * Web search result item
 * @typedef {Object} SearchResult
 * @property {string} title - Result title
 * @property {string} url - Result URL
 * @property {string} snippet - Result snippet/description
 */

/**
 * Perform a web search using the configured provider
 * @param {string} query - Search query
 * @param {number} [maxResults=10] - Maximum number of results to return
 * @returns {Promise<SearchResult[]>} Array of search results
 */
export async function performWebSearch(query, maxResults = 10) {
    const provider = SEARCH_CONFIG.provider || 'duckduckgo';

    console.log(`[Search] Performing search with ${provider}: "${query}"`);

    try {
        let results;
        switch (provider) {
            case 'serper':
                results = await searchWithSerper(query, maxResults);
                break;
            case 'bing':
                results = await searchWithBing(query, maxResults);
                break;
            case 'duckduckgo':
            default:
                results = await searchWithDuckDuckGo(query, maxResults);
                break;
        }

        console.log(`[Search] Got ${results.length} results`);
        return results;
    } catch (error) {
        console.error(`[Search] Search failed:`, error.message);
        // Return empty results with error info
        return [{
            title: 'Search Error',
            url: '',
            snippet: `Failed to perform web search: ${error.message}`
        }];
    }
}

/**
 * Format search results as text for the model
 * @param {SearchResult[]} results - Search results
 * @param {string} query - Original query
 * @returns {string} Formatted text
 */
export function formatSearchResults(results, query) {
    if (!results || results.length === 0) {
        return `No search results found for: "${query}"`;
    }

    const lines = [`Web search results for "${query}":\n`];

    results.forEach((result, index) => {
        lines.push(`${index + 1}. ${result.title}`);
        if (result.url) {
            lines.push(`   URL: ${result.url}`);
        }
        lines.push(`   ${result.snippet}`);
        lines.push('');
    });

    return lines.join('\n');
}

/**
 * Search using Serper.dev (Google Search API)
 * Requires SERPER_API_KEY environment variable
 */
async function searchWithSerper(query, maxResults) {
    const apiKey = SEARCH_CONFIG.serperApiKey || process.env.SERPER_API_KEY;
    if (!apiKey) {
        throw new Error('SERPER_API_KEY not configured');
    }

    const response = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            q: query,
            num: maxResults
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Serper API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const results = [];

    // Extract organic results
    if (data.organic) {
        for (const item of data.organic.slice(0, maxResults)) {
            results.push({
                title: item.title || '',
                url: item.link || '',
                snippet: item.snippet || ''
            });
        }
    }

    // Include knowledge graph if available
    if (data.knowledgeGraph && results.length < maxResults) {
        results.unshift({
            title: data.knowledgeGraph.title || 'Knowledge Panel',
            url: data.knowledgeGraph.website || '',
            snippet: data.knowledgeGraph.description || ''
        });
    }

    return results;
}

/**
 * Search using Bing Web Search API
 * Requires BING_API_KEY environment variable
 */
async function searchWithBing(query, maxResults) {
    const apiKey = SEARCH_CONFIG.bingApiKey || process.env.BING_API_KEY;
    if (!apiKey) {
        throw new Error('BING_API_KEY not configured');
    }

    const url = new URL('https://api.bing.microsoft.com/v7.0/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));
    url.searchParams.set('responseFilter', 'Webpages');

    const response = await fetch(url.toString(), {
        headers: {
            'Ocp-Apim-Subscription-Key': apiKey
        }
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Bing API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const results = [];

    if (data.webPages && data.webPages.value) {
        for (const item of data.webPages.value.slice(0, maxResults)) {
            results.push({
                title: item.name || '',
                url: item.url || '',
                snippet: item.snippet || ''
            });
        }
    }

    return results;
}

/**
 * Search using DuckDuckGo HTML parsing
 * Free, no API key needed, but may be rate limited
 */
async function searchWithDuckDuckGo(query, maxResults) {
    // Use DuckDuckGo HTML endpoint
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);

    const response = await fetch(url.toString(), {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    if (!response.ok) {
        throw new Error(`DuckDuckGo request failed: ${response.status}`);
    }

    const html = await response.text();
    const results = parseDuckDuckGoResults(html, maxResults);

    return results;
}

/**
 * Parse DuckDuckGo HTML results
 * @param {string} html - HTML content
 * @param {number} maxResults - Maximum results to extract
 * @returns {SearchResult[]}
 */
function parseDuckDuckGoResults(html, maxResults) {
    const results = [];

    // Match result entries - DuckDuckGo uses result__a for links
    // Pattern: <a class="result__a" href="...">Title</a>
    // And: <a class="result__snippet" href="...">Snippet...</a>

    // Extract result blocks
    const resultRegex = /<div class="result[^"]*results_links[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi;
    const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
    const snippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i;

    let match;
    const resultBlocks = html.match(resultRegex) || [];

    for (const block of resultBlocks) {
        if (results.length >= maxResults) break;

        const linkMatch = block.match(linkRegex);
        const snippetMatch = block.match(snippetRegex);

        if (linkMatch) {
            let url = linkMatch[1];
            // DuckDuckGo uses redirects, extract actual URL
            const actualUrlMatch = url.match(/uddg=([^&]+)/);
            if (actualUrlMatch) {
                url = decodeURIComponent(actualUrlMatch[1]);
            }

            const title = stripHtml(linkMatch[2]);
            const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';

            if (title && url) {
                results.push({ title, url, snippet });
            }
        }
    }

    // Fallback: simpler regex for basic extraction
    if (results.length === 0) {
        const simpleResultRegex = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
        while ((match = simpleResultRegex.exec(html)) !== null && results.length < maxResults) {
            const url = match[1];
            const title = match[2].trim();

            // Skip DuckDuckGo internal links
            if (!url.includes('duckduckgo.com') && title.length > 5) {
                results.push({
                    title,
                    url,
                    snippet: ''
                });
            }
        }
    }

    return results;
}

/**
 * Strip HTML tags from text
 * @param {string} html - HTML string
 * @returns {string} Plain text
 */
function stripHtml(html) {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export default {
    performWebSearch,
    formatSearchResults
};
