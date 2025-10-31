// ==UserScript==
// @name         Content Classification for Reddit (Ollama) with IndexedDB
// @namespace    http://tampermonkey.net/
// @version      2025.10.26
// @description  Classifies Reddit posts using a local Ollama instance and displays tags.
// @author       You (with AI refinements)
// @match        https://*.reddit.com/r/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=reddit.com
// @require      https://cdn.jsdelivr.net/npm/marked/marked.min.js
// @require      https://cdn.jsdelivr.net/npm/idb/build/umd.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// ==/UserScript==

/*
Types of Thing
t1 Comment
t2 Account
t3 Link
t4 Message
t5 Subreddit
t6 Award
t8 PromoCampaign
*/

(function () {
    'use strict';

    // --- Database Functions ---
    let db = null;

    // --- Configuration ---
    const OLLAMA_BASE_URL = "http://localhost:11434";
    const OLLAMA_CHAT_ENDPOINT = "/api/chat";
    const OLLAMA_TAGS_ENDPOINT = "/api/tags";
    const OLLAMA_MODEL = "gemma3:4b";

    const COMMENT_THREADS = 15;
    const MIN_CHILD_COMMENTS_FOR_SUMMARY = 5; // Don't summarize comment threads with this many or fewer child comments.

    const SUMMARY_SYSTEM_PROMPT = `Please provide a detailed summary of the given text, organized into logical sections with descriptive titles. For each section, include a title that captures the main theme or topic, followed by three or more sentences that provide supporting details, examples, or explanations. Aim to create a summary that is accurate, concise, and thorough, while maintaining readability through the use of bullet points and clear formatting. The summary should be structured as follows:

# **Summary:**
## **[Section Title]:**
- [Supporting detail]
- [Supporting detail]
- [Supporting detail]
## **[Section Title]:**
- [Supporting detail]
- [Supporting detail]
- [Supporting detail]
...

Continue this format for each logical section of the text, ensuring that the sections flow logically and cover all the main points discussed in the text. If necessary, you may include subsections to further organize the information within each main section.`;

    const CLASSIFICATION_SYSTEM_PROMPT = `You are an expert text classification AI. Your task is to analyze Reddit post titles and accompanying descriptions (if provided) and identify relevant categories for each post.

    **Input:**
    You will receive a string containing the subreddit, the post title, and potentially a flair or a short description, formatted as: \`r/subredditName Post Title OptionalFlair - OptionalDescription\`

    **Output:**
    Your output MUST be a JSON list of strings, where each string represents a category you have identified for the input text.
    - The categories should be concise and descriptive.
    - A post can belong to multiple categories.
    - Determine the categories based on the content of the input. There is no predefined list of categories.
    - If the content suggests a "Not Safe For Work" (NSFW) nature, include "NSFW" as one of the categories.
    - Do NOT include any introductory text, explanations, or any characters before or after the JSON list.
    - The output must be plain text, directly parsable as a JSON list. Do NOT wrap the JSON list in Markdown code blocks (e.g., \`\`\`json ... \`\`\`) or any other formatting.
    - If no specific tags apply, return an empty array.

    **Examples:**

    **Input:** \`r/cats She blinked once and I canceled all my plans.Cat Picture - OC\`
    **Output:** ["Animal", "Cat"]

    **Input:** \`r/hockeyTeam USA accepts the Men's World Championship trophy with a Johnny Gaudreau jersey in hand\`
    **Output:** ["Sports", "Hockey", "USA"]

    **Input:** \`r/StockMarket US economy: Let that sink in ..Discussion\`
    **Output:** ["Economy", "Finance", "USA"]

    **Input:** \`r/worldnews Trump administration finally responds to large-scale Russian attacks on UkraineRussia/Ukraine\`
    **Output:** ["Politics", "News", "World News", "Russia", "Ukraine", "USA"]

    **Input:** \`r/awfuleverything Aftermath of the room Bonnie Blue claims to have had sex with 1,057 men in 12 hours\`
    **Output:** ["NSFW", "Shocking"]

    **Input:** \`r/science Researchers discover a new enzyme that breaks down plastics at record speed.Research\`
    **Output:** ["Science", "Environment", "Technology", "Research"]

    **Input:** \`r/gaming Just finished this masterpiece after 100 hours! What a journey!Screenshot\`
    **Output:** ["Gaming", "Entertainment"]

    Now, classify the following input:`;

    const COMMENTS_SYSTEM_PROMPT_old = `You are a Reddit comment summarization expert.
The user will provide a JSON object containing Reddit comment threads.
Your task is to identify and extract the main "Key Points" discussed within these comments.
Present these "Key Points" as a bulleted list.
Do not include any introductory phrases or conversational filler in your response.
Directly output the "Key Points" section.

Example of bulleted list output format:

- <Title for Key Point 1>: <Short explanation of what Key Point 1 is about, drawing from the comments.>
- <Title for Key Point 2>: <Short explanation of what Key Point 2 is about, drawing from the comments.>`;

    const COMMENTS_SYSTEM_PROMPT = `You are a Reddit comment summarization expert.
Your task is to identify and extract the main points discussed within these comments.
Present them as a bulleted list.
Do not include any introductory phrases or conversational filler in your response.`;

    const OLLAMA_REQUEST_TIMEOUT_MS = 30 * 1000; // Timeout for Ollama chat requests
    const OLLAMA_HEALTH_CHECK_TIMEOUT_MS = 5 * 1000; // Timeout for checking Ollama availability

    // CSS classes and styles
    const STAMP_CLASS = "stamp";
    // Inline styles will be applied directly for simplicity and to honor the "color: red" request conditionally.
    // GM_addStyle is used here for styles that are common to all stamps added by this script,
    // and to ensure our stamps are distinguishable or have base styling if Reddit's .stamp is minimal.
    GM_addStyle(`
            .userscript-classification-stamp.${STAMP_CLASS} {
                margin-left: 0.5rem;
            }
        `);

    // --- State ---
    let isOllamaAvailable = false; // Flag to track Ollama availability

    // --- Helper Functions ---
    function chunkArray(arr, chunkSize) {
        const chunkedArray = [];
        for (let i = 0; i < arr.length; i += chunkSize) {
            chunkedArray.push(arr.slice(i, i + chunkSize));
        }
        return chunkedArray;
    }

    /**
     * Makes a request to the Ollama API.
     * @param {'GET' | 'POST'} method - The HTTP method.
     * @param {string} endpoint - The API endpoint (e.g., /api/chat).
     * @param {object} [payload=null] - The data to send (for POST requests).
     * @param {number} [timeout=OLLAMA_REQUEST_TIMEOUT_MS] - Request timeout in milliseconds.
     * @returns {Promise<object>} A promise that resolves with the JSON response from Ollama.
     * @throws {Error} If the request fails or the response is not valid JSON.
     */
    async function makeOllamaRequest(method, endpoint, payload = null, timeout = OLLAMA_REQUEST_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            const details = {
                method: method,
                url: `${OLLAMA_BASE_URL}${endpoint}`,
                headers: { 'Content-Type': 'application/json' },
                timeout: timeout,
                onload: function (response) {
                    try {
                        if (response.status >= 200 && response.status < 300) {
                            const json = JSON.parse(response.responseText);
                            resolve(json);
                        } else {
                            console.error(`Ollama API error: ${response.status} ${response.statusText}`, response.responseText);
                            reject(new Error(`Ollama API error: ${response.status} - ${response.statusText}`));
                        }
                    } catch (e) {
                        console.error('Error parsing Ollama response:', e, response.responseText);
                        reject(new Error('Failed to parse Ollama response.'));
                    }
                },
                onerror: function (error) {
                    console.error(`GM_xmlhttpRequest error for ${method} ${endpoint}:`, error);
                    reject(new Error(`Network error or Ollama unreachable for ${method} ${endpoint}.`));
                },
                ontimeout: function () {
                    console.error(`GM_xmlhttpRequest timeout for ${method} ${endpoint}`);
                    reject(new Error(`Request to Ollama timed out for ${method} ${endpoint}.`));
                }
            };

            if (payload) {
                details.data = JSON.stringify(payload);
            }

            GM_xmlhttpRequest(details);
        });
    }

    /**
     * Fetches content classification from Ollama for a given text prompt.
     * @param {string} promptText - The text to classify.
     * @returns {Promise<object|null>} A promise that resolves with the Ollama response object, or null on error.
     */
    async function fetchClassificationFromOllama(promptText) {
        const payload = {
            model: OLLAMA_MODEL,
            num_ctx: 32000,
            stream: false,
            temperature: 0.75,
            messages: [
                { "role": "system", "content": CLASSIFICATION_SYSTEM_PROMPT },
                { "role": "user", "content": promptText },
            ]
        };

        try {
            // console.debug("Sending to Ollama:", JSON.stringify(payload, null, 2));
            const response = await makeOllamaRequest('POST', OLLAMA_CHAT_ENDPOINT, payload);
            // console.debug("Received from Ollama:", response);
            return response;
        } catch (error) {
            console.error('Error fetching classification from Ollama:', error);
            return null;
        }
    }

    /**
     * Extracts relevant information from a Reddit post element (t3 item).
     * @param {HTMLElement} t3Node - The DOM element representing the Reddit post.
     * @returns {string|null} A formatted prompt string for Ollama, or null if essential info is missing.
     */
    function buildPromptFromT3Node(t3Node) {
        // Check if t3Node is a valid DOM element
        if (!t3Node || typeof t3Node.getAttribute !== 'function') return null;

        // isOver18: checks for 'over18' class
        const isOver18 = t3Node.classList.contains('over18') ? "[18+] " : "";

        // isNsfw: checks the 'data-nsfw' attribute
        const nsfwAttribute = t3Node.getAttribute('data-nsfw');
        const isNsfw = nsfwAttribute === 'true' ? "[NSFW] " : "";

        // isSpoiler: checks the 'data-spoiler' attribute
        const spoilerAttribute = t3Node.getAttribute('data-spoiler');
        const isSpoiler = spoilerAttribute === 'true' ? "[Spoiler] " : "";

        // subredditPrefixed: gets 'data-subreddit-prefixed' attribute
        const subredditAttr = t3Node.getAttribute('data-subreddit-prefixed');
        const subredditPrefixed = subredditAttr ? `${subredditAttr} ` : "";

        // title: queries for the title element and gets its text content
        const titleElement = t3Node.querySelector('p.title > a.title, a.title');
        const titleText = titleElement ? titleElement.textContent.trim() : null;

        // If there's no title, it's unlikely to be a classifiable post
        if (!titleText) return null;

        // Construct the final string
        return `${isOver18}${isNsfw}${isSpoiler}${subredditPrefixed}${titleText}`;
    }

    /**
     * Parses the Ollama model's output to extract a list of classification tags.
     * Handles cases where the output might be a JSON string, a JSON string within backticks,
     * or a string containing a JSON array.
     * @param {string} rawOutput - The raw string content from Ollama's message.
     * @returns {string[]} An array of classification strings, or an empty array if parsing fails or output is invalid.
     */
    function parseOllamaOutput(rawOutput) {
        if (typeof rawOutput !== 'string' || !rawOutput.trim()) {
            return [];
        }

        let contentToParse = rawOutput.trim();

        // Try to find content inside triple backtick json code blocks
        const jsonBlockMatch = contentToParse.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (jsonBlockMatch && jsonBlockMatch[1]) {
            contentToParse = jsonBlockMatch[1].trim();
        }

        try {
            const parsed = JSON.parse(contentToParse);
            if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
                return parsed;
            }
        } catch (error) {
            // If direct parsing fails, try to extract a list structure '\[.*\]'
            const listMatch = contentToParse.match(/(\[.*?\])/s);
            if (listMatch && listMatch[1]) {
                try {
                    const parsedList = JSON.parse(listMatch[1]);
                    if (Array.isArray(parsedList) && parsedList.every(item => typeof item === 'string')) {
                        return parsedList;
                    }
                } catch (listError) {
                    // console.warn('Failed to parse extracted list from Ollama output:', listError, contentToParse);
                }
            } else {
                // console.warn('Ollama output is not valid JSON or a recognized format:', contentToParse);
            }
        }
        // Fallback: if the raw output (after potential ``` stripping) is a simple comma-separated list without brackets
        // and doesn't look like JSON, we could try splitting it.
        // For now, strict JSON array parsing is preferred for reliability from the LLM.
        // If it wasn't parsed as a JSON array by now, return empty.
        return [];
    }

    /**
     * Initialize IndexedDB connection
     */
    async function initDatabase() {
        try {
            db = await idb.openDB('ollama_reddit', 1, {
                upgrade(db) {
                    // Create t3_link table for posts
                    if (!db.objectStoreNames.contains('t3_link')) {
                        const t3Store = db.createObjectStore('t3_link', { keyPath: 'link_id' });
                        t3Store.createIndex('link_id', 'link_id', { unique: true });
                    }

                    // Create t1_comment table for comments
                    if (!db.objectStoreNames.contains('t1_comment')) {
                        const t1Store = db.createObjectStore('t1_comment', { keyPath: 'comment_id' });
                        t1Store.createIndex('comment_id', 'comment_id', { unique: true });
                    }
                },
            });
            console.log('Database initialized successfully');
        } catch (error) {
            console.error('Failed to initialize database:', error);
            showTemporaryMessage('white', 'red', 'Database initialization failed');
        }
    }

    /**
     * Get classification from database
     */
    async function getClassificationFromDB(linkId) {
        if (!db) return null;
        try {
            const tx = db.transaction('t3_link', 'readonly');
            const store = tx.objectStore('t3_link');
            const result = await store.get(linkId);
            return result?.link_classification || null;
        } catch (error) {
            console.error('Error reading classification from DB:', error);
            return null;
        }
    }

    /**
     * Save classification to database
     */
    async function saveClassificationToDB(linkId, classification) {
        if (!db) return;
        try {
            const tx = db.transaction('t3_link', 'readwrite');
            const store = tx.objectStore('t3_link');
            await store.put({ link_id: linkId, link_classification: classification });
        } catch (error) {
            console.error('Error saving classification to DB:', error);
            showTemporaryMessage('white', 'red', 'Failed to save classification to database');
        }
    }

    /**
     * Get summary from database
     */
    async function getSummaryFromDB(linkId) {
        if (!db) return null;
        try {
            const tx = db.transaction('t3_link', 'readonly');
            const store = tx.objectStore('t3_link');
            const result = await store.get(linkId);
            return result?.link_summary || null;
        } catch (error) {
            console.error('Error reading summary from DB:', error);
            return null;
        }
    }

    /**
     * Save summary to database
     */
    async function saveSummaryToDB(linkId, summary) {
        if (!db) return;
        try {
            const tx = db.transaction('t3_link', 'readwrite');
            const store = tx.objectStore('t3_link');

            // Get existing record or create new one
            const existing = await store.get(linkId);
            const record = existing || { link_id: linkId };
            record.link_summary = summary;

            await store.put(record);
        } catch (error) {
            console.error('Error saving summary to DB:', error);
            showTemporaryMessage('white', 'red', 'Failed to save summary to database');
        }
    }

    /**
     * Get comment summary from database
     */
    async function getCommentSummaryFromDB(commentId) {
        if (!db) return null;
        try {
            const tx = db.transaction('t1_comment', 'readonly');
            const store = tx.objectStore('t1_comment');
            const result = await store.get(commentId);
            return result?.comment_summary || null;
        } catch (error) {
            console.error('Error reading comment summary from DB:', error);
            return null;
        }
    }

    /**
     * Save comment summary to database
     */
    async function saveCommentSummaryToDB(commentId, summary) {
        if (!db) return;
        try {
            const tx = db.transaction('t1_comment', 'readwrite');
            const store = tx.objectStore('t1_comment');
            await store.put({ comment_id: commentId, comment_summary: summary });
        } catch (error) {
            console.error('Error saving comment summary to DB:', error);
            showTemporaryMessage('white', 'red', 'Failed to save comment summary to database');
        }
    }

    /**
     * Adds classification tags to a Reddit post element.
     * @param {HTMLElement} t3Node - The DOM element representing the Reddit post.
     * @param {string[]} classifications - An array of classification strings.
     */
    function addClassificationsToT3Node(t3Node, classifications) {
        if (!t3Node || !classifications || classifications.length === 0) {
            return;
        }

        const targetElement = t3Node.querySelector('p.tagline'); // Standard location for post metadata
        if (!targetElement) {
            // console.warn("Could not find tagline element to add classification:", t3Node);
            return;
        }

        // Example blacklist for special styling
        const blacklist = ["politics"];

        classifications.forEach(tagText => {
            if (typeof tagText !== 'string' || !tagText.trim()) return;

            const span = document.createElement('span');
            span.className = `userscript-classification-stamp ${STAMP_CLASS}`;
            span.textContent = tagText.trim();

            // Apply conditional styling (e.g., red color for blacklisted tags)
            // This respects the user's desire for "color: red;" on certain tags.
            if (blacklist.some(blacklistedTerm => tagText.toLowerCase().includes(blacklistedTerm.toLowerCase()))) {
                span.style.color = 'red';
                t3Node.style.backgroundColor = '#7003';
            }

            targetElement.appendChild(span);
        });
    }

    /**
     * Processes a single Reddit post: gets classification and updates the DOM.
     * Now with database caching support.
     * @param {HTMLElement} t3Node - The DOM element of the post.
     */
    async function classifyAndDisplayForT3Node(t3Node) {
        // Add a marker to prevent re-processing
        if (t3Node.dataset.classificationProcessed === 'true') {
            return;
        }
        t3Node.dataset.classificationProcessed = 'true';

        const promptText = buildPromptFromT3Node(t3Node);
        if (!promptText) {
            return;
        }

        // Extract link ID from the element
        const linkId = t3Node.id || null;
        if (!linkId) {
            console.warn('No ID found for t3Node, skipping database cache');
        }

        let parsedClassifications = null;

        // Try to get from database first
        if (linkId) {
            parsedClassifications = await getClassificationFromDB(linkId);
            if (parsedClassifications && parsedClassifications.length > 0) {
                console.log(`Using cached classification for ${linkId}:`, parsedClassifications);
                addClassificationsToT3Node(t3Node, parsedClassifications);
                return;
            }
        }

        // If not in cache, get from Ollama
        console.log(`Requesting classification for: ${promptText}`);
        const ollamaResponse = await fetchClassificationFromOllama(promptText);

        if (ollamaResponse && ollamaResponse.message && ollamaResponse.message.content) {
            parsedClassifications = parseOllamaOutput(ollamaResponse.message.content);
            console.log(`Parsed classifications for "${promptText}":`, parsedClassifications);

            // Remove duplicates and sort
            if (parsedClassifications && parsedClassifications.length > 0) {
                const s = new Set(parsedClassifications);
                parsedClassifications = [...s];
                parsedClassifications.sort();
            }

            // Save to database
            if (linkId && parsedClassifications) {
                await saveClassificationToDB(linkId, parsedClassifications);
            }

            addClassificationsToT3Node(t3Node, parsedClassifications);
        } else {
            console.warn("No valid response or content from Ollama for prompt:", promptText);
        }
    }

    /**
     * Iterates over a collection of post elements and processes them sequentially.
     * @param {HTMLCollection|NodeList|HTMLElement[]} t3Nodes - A collection of post elements.
     */
    async function runClassificationOnPostsChucks(t3Nodes) {
        if (!isOllamaAvailable) {
            console.warn("Ollama is not available. Classification will not run.");
            return;
        }

        // Convert HTMLCollection/NodeList to Array to be safe, though for...of works directly
        const postsArray = Array.from(t3Nodes);

        // for (const t3Node of postsArray) { ... } // sequentially; slow af
        // postsArray.forEach(async (t3Node) => { ... }); // parallel; my pc burns help

        const chunkSize = 5;
        const chunkedPosts = chunkArray(postsArray, chunkSize); // chunked

        for (const chunk of chunkedPosts) {
            await Promise.all(chunk.map(async (t3Node) => {
                // Ensure it's an element node and looks like a post (e.g., has 'thing' class)
                if (t3Node.nodeType === Node.ELEMENT_NODE && t3Node.classList.contains('thing')) {
                    try {
                        await classifyAndDisplayForT3Node(t3Node);
                    } catch (error) {
                        console.error("Error processing a T3 node:", error, t3Node);
                        // Mark as processed even on error to avoid retrying problematic posts
                        t3Node.dataset.classificationProcessed = 'true';
                    }
                }
            }));
        }
    }

    /**
     * Limits the concurrency of async tasks for elements.
     * @param {Array} items - Array of items to process
     * @param {number} concurrencyLimit - Number of concurrent executions
     * @param {Function} asyncFn - Async function to run for each item
     */
    async function asyncPool(items, concurrencyLimit, asyncFn) {
        const executing = [];
        for (const item of items) {
            const p = (async () => {
                await asyncFn(item);
            })();
            executing.push(p);

            if (executing.length >= concurrencyLimit) {
                await Promise.race(executing);
                // Clean up settled promises
                for (let i = executing.length - 1; i >= 0; i--) {
                    if (executing[i].status === 'fulfilled' || executing[i].status === 'rejected') {
                        executing.splice(i, 1);
                    }
                }
            }
        }
        await Promise.all(executing);
    }

    /**
     * Iterates over a collection of post elements and processes them with limited concurrency.
     * @param {HTMLCollection|NodeList|HTMLElement[]} t3Nodes - A collection of post elements.
     */
    async function runClassificationOnPosts(t3Nodes) {
        if (!isOllamaAvailable) {
            console.warn("Ollama is not available. Classification will not run.");
            return;
        }

        const postsArray = Array.from(t3Nodes);
        const concurrencyLimit = 5;

        await asyncPool(postsArray, concurrencyLimit, async (t3Node) => {
            if (t3Node.nodeType === Node.ELEMENT_NODE && t3Node.classList.contains('thing')) {
                try {
                    await classifyAndDisplayForT3Node(t3Node);
                } catch (error) {
                    console.error("Error processing a T3 node:", error, t3Node);
                    t3Node.dataset.classificationProcessed = 'true';
                }
            }
        });
    }

    /**
     * Checks if the Ollama instance is available.
     * @returns {Promise<boolean>} True if Ollama is available, false otherwise.
     */
    async function checkOllamaAvailability() {
        try {
            // A lightweight request to check if Ollama is responsive (e.g., list models)
            await makeOllamaRequest('GET', OLLAMA_TAGS_ENDPOINT, null, OLLAMA_HEALTH_CHECK_TIMEOUT_MS);
            console.info("Ollama instance is available.");
            isOllamaAvailable = true;
            return true;
        } catch (error) {
            console.warn("Ollama instance not available or error checking status. The script's core functionality might be disabled.", error.message);
            isOllamaAvailable = false;
            // Optionally, display a persistent message to the user on the page
            // e.g., by injecting a small banner.
            return false;
        }
    }

    function showTimedMessage(message, color, backgroundColor) {
        const messageDiv = document.createElement('div');
        messageDiv.textContent = message;
        messageDiv.style.cssText = `
                position: fixed;
                top: 10px;
                right: 10px;
                background-color: ${backgroundColor};
                color: ${color};
                border: 1px solid ${color};
                padding: 10px;
                z-index: 9999;
                font-size: 14px;
                max-width: 40rem;
                box-sizing: border-box;
            `;
        document.body.appendChild(messageDiv);
        setTimeout(() => messageDiv.remove(), 100 * 1000); // Remove after 100 seconds
    }

    /**
     * Displays a temporary floating message in the corner of the page.
     * Stacks messages if called quickly.
     * @param {string} color - Text color.
     * @param {string} backgroundColor - Background color.
     * @param {string} message - Message to display.
     */
    function showTemporaryMessage(color, backgroundColor, message) {
        const messageDiv = document.createElement('div');
        messageDiv.textContent = message;
        messageDiv.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            background-color: ${backgroundColor};
            color: ${color};
            padding: 10px;
            z-index: 9999;
            font-size: 14px;
            max-width: 40rem;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            border-radius: 5px;
            transition: top 0.3s;
        `;

        // Stack messages downward if more than one
        const prevMsgs = document.querySelectorAll('.reddit-ollama-gmmsg');
        messageDiv.classList.add('reddit-ollama-gmmsg');
        messageDiv.style.top = `${10 + (prevMsgs.length * 45)}px`;

        document.body.appendChild(messageDiv);

        setTimeout(() => {
            messageDiv.remove();
            // Re-stack remaining messages
            document.querySelectorAll('.reddit-ollama-gmmsg').forEach((elem, i) => {
                elem.style.top = `${10 + (i * 45)}px`;
            });
        }, 10 * 1000);
    }

    function formatTimeDelta(ms) {
        const minutes = Math.floor(ms / 60000);
        const seconds = ((ms % 60000) / 1000).toFixed(3);
        return `${minutes}:${seconds.padStart(6, '0')}`;
    }

    /**
     * Adds summary generation buttons to Reddit posts in a robust and idempotent way.
     * @param {NodeList|Array<Element>} t3Nodes - A collection of Reddit post elements ('.thing').
     */
    function addSummaryButtonsToPosts(t3Nodes) {
        if (!t3Nodes || t3Nodes.length === 0) return;

        const isComments = window.location.pathname.includes('/comments/');
        const processedMarkerClass = 'summary-button-added';

        Array.from(t3Nodes).forEach((t3Node) => {
            if (!(t3Node instanceof Element) || t3Node.classList.contains(processedMarkerClass)) {
                return;
            }

            const isTextPost = t3Node.querySelector('.usertext-body.md-container');
            if (isComments && !isTextPost) {
                t3Node.classList.add(processedMarkerClass);
                return;
            }

            const flatlistButton = t3Node.querySelector('.flat-list.buttons');
            if (!flatlistButton) {
                t3Node.classList.add(processedMarkerClass);
                return;
            }

            t3Node.classList.add(processedMarkerClass);

            const innerButton = document.createElement('a');
            innerButton.textContent = 'generate summary';
            innerButton.style.cursor = 'pointer';
            innerButton.href = 'javascript:void(0);';

            const inlineButton = document.createElement('li');
            inlineButton.append(innerButton);
            flatlistButton.append(inlineButton);

            innerButton.onclick = async () => {
                const timeStart = Date.now();

                if (innerButton.dataset.generating === 'true') return;

                const linkId = t3Node.id || null;

                // Check database first
                let cachedSummary = null;
                if (linkId) {
                    cachedSummary = await getSummaryFromDB(linkId);
                }

                let outerSummaryContainer = t3Node.querySelector('.summary-outer-container');
                let summaryContainer;

                if (outerSummaryContainer) {
                    summaryContainer = outerSummaryContainer.querySelector('.md');
                    if (cachedSummary) {
                        summaryContainer.innerHTML = marked.parse(cachedSummary) + `<br><span style="color: #777777">Cached summary</span>`;
                        return;
                    } else {
                        summaryContainer.innerHTML = `<span style="color: #777777">Regenerating with ${OLLAMA_MODEL}...</span>`;
                    }
                } else {
                    const postBody = t3Node.querySelector('.usertext-body.md-container');
                    outerSummaryContainer = document.createElement('div');
                    outerSummaryContainer.className = "usertext-body md-container summary-outer-container";
                    outerSummaryContainer.style.marginBottom = '1rem';

                    summaryContainer = document.createElement('div');
                    summaryContainer.className = "md";
                    outerSummaryContainer.append(summaryContainer);

                    if (postBody) {
                        postBody.insertAdjacentElement('afterend', outerSummaryContainer);
                    } else {
                        t3Node.querySelector('.entry').insertAdjacentElement('afterend', outerSummaryContainer);
                    }

                    if (cachedSummary) {
                        summaryContainer.innerHTML = marked.parse(cachedSummary) + `<br><span style="color: #777777">Cached summary</span>`;
                        return;
                    }
                }

                summaryContainer.innerHTML = `<span style="color: #777777">Generating with ${OLLAMA_MODEL}...</span>`;

                const postTitle = t3Node.querySelector('a.title')?.textContent || "No title";
                const postLink = t3Node.querySelector('a.title')?.href || "";
                const postBodyElement = t3Node.querySelector('.usertext-body.md-container');
                const postInnerText = postBodyElement?.textContent.trim() || "";

                let contentToSummarize = `Title: ${postTitle}\n`;
                if (postInnerText) {
                    contentToSummarize += `\nPost Body:\n${postInnerText}`;
                } else {
                    contentToSummarize += `\nThis is a link post pointing to: ${postLink}`;
                }

                try {
                    innerButton.dataset.generating = 'true';
                    innerButton.style.opacity = '0.5';

                    const payload = {
                        model: OLLAMA_MODEL,
                        num_ctx: 64000,
                        stream: false,
                        temperature: 0.75,
                        messages: [
                            { "role": "system", "content": SUMMARY_SYSTEM_PROMPT },
                            { "role": "user", "content": contentToSummarize },
                        ]
                    };

                    const response = await makeOllamaRequest('POST', OLLAMA_CHAT_ENDPOINT, payload);

                    if (response?.message?.content) {
                        const summaryContent = response.message.content;
                        summaryContainer.innerHTML = marked.parse(summaryContent) + `<br><span style="color: #777777">Generated with ${OLLAMA_MODEL} in ${formatTimeDelta(Date.now() - timeStart)}s</span>`;

                        // Save to database
                        if (linkId) {
                            await saveSummaryToDB(linkId, summaryContent);
                        }
                    } else {
                        throw new Error("Invalid response structure from Ollama.");
                    }

                } catch (error) {
                    summaryContainer.innerHTML = `<span style="color: #cc0000">Failed to summarize post. Check console for details.</span>`;
                    console.error("Summary generation failed:", error);
                } finally {
                    innerButton.dataset.generating = 'false';
                    innerButton.style.opacity = '1';
                }
            };

            if (isComments) innerButton.click();
        });
    }

    /**
     * Main function to initialize the script.
     * Sets up observers for new content.
     */
    async function initialize() {
        // Initialize database first
        await initDatabase();

        await checkOllamaAvailability();
        if (!isOllamaAvailable) {
            showTemporaryMessage('#fff', '#f00', 'Ollama not detected. Reddit content classification is disabled.');
            return;
        }

        const siteTable = document.getElementById('siteTable');

        if (siteTable) {
            addSummaryButtonsToPosts(siteTable.children);
            runClassificationOnPosts(siteTable.children);

            const observer = new MutationObserver((mutationsList) => {
                for (const mutation of mutationsList) {
                    if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                        mutation.addedNodes.forEach(node => {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                if (node.classList.contains('sitetable')) {
                                    addSummaryButtonsToPosts(node.children);
                                    runClassificationOnPosts(node.children);
                                }
                                else if (node.classList.contains('thing')) {
                                    addSummaryButtonsToPosts([node]);
                                    runClassificationOnPosts([node]);
                                }
                                else if (node.querySelector && node.querySelector('.thing')) {
                                    addSummaryButtonsToPosts(node.querySelectorAll('.thing'));
                                    runClassificationOnPosts(node.querySelectorAll('.thing'));
                                }
                            }
                        });
                    }
                }
            });

            observer.observe(siteTable, { childList: true, subtree: true });
            console.log("Userscript initialized and observing for new Reddit posts.");
        } else {
            console.warn("Could not find #siteTable element. Classification may not work on this page.");
        }
    }

    // --- Script Execution ---
    // Use window.addEventListener('load', ...) if you need to wait for all page resources.
    // For userscripts, often running after DOMContentLoaded or even sooner is fine if elements are consistently available.
    // Given Reddit's dynamic nature and RES, 'load' is a safer bet, or a DOMContentLoaded check + delay.
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize(); // DOMContentLoaded has already fired
    }

    // --------------------

    /**
     * Scrapes Reddit comments and returns a nested comment tree.
     * Note: Only works on old Reddit design.
     * @returns {object} Contains title, subreddit, and comments.
     */
    function scrapeRedditComments() {
        /**
         * Recursively extract comment and its children.
         * @param {Element} commentElement
         * @returns {object}
         */
        function getCommentData(commentElement) {
            const id = commentElement.id || null;
            const commentTextElement = commentElement.querySelector('.md');
            const comment = commentTextElement ? commentTextElement.textContent.trim() : '';
            const children = [];

            // Try both child selectors for children comments
            const childList = commentElement.querySelector('.child > .sitetable');
            if (childList) {
                const directChildren = Array.from(childList.children).filter(el => el.matches('.comment'));
                directChildren.forEach(child => {
                    children.push(getCommentData(child));
                });
            }

            return { id, comment, children };
        }

        // Top-level comments only
        const topLevelComments = document.querySelectorAll('.commentarea > .sitetable > .comment');
        const allComments = [];
        topLevelComments.forEach(commentElement => allComments.push(getCommentData(commentElement)));

        // Scrape thread title & subreddit
        const t3Entry = document.querySelector('div.thing');
        const subreddit = t3Entry?.getAttribute('data-subreddit-prefixed') ?? '';
        const titleElem = t3Entry?.querySelector('p.title > a.title, a.title');
        const title = titleElem?.textContent?.trim() || '';

        return {
            title,
            subreddit,
            comments: allComments
        };
    }

    /**
     * Recursively removes 'id' fields from the comment data object.
     * @param {object|array} obj
     * @returns {object|array}
     */
    function removeIdRecursively(obj) {
        if (Array.isArray(obj)) {
            return obj.map(removeIdRecursively);
        } else if (obj && typeof obj === 'object') {
            const newObj = {};
            for (const [key, value] of Object.entries(obj)) {
                if (key === 'id') continue;
                if (key === 'children' && Array.isArray(value)) {
                    newObj[key] = removeIdRecursively(value);
                } else {
                    newObj[key] = removeIdRecursively(value);
                }
            }
            return newObj;
        }
        return obj;
    }

    /**
     * Main: Summarizes comments using Ollama, and inserts the result below each comment.
     * Only processes first few comments for performance.
     */
    async function runCommentsSummarize() {
        if (!window.location.pathname.includes('/comments/')) return;


        await checkOllamaAvailability();
        if (!isOllamaAvailable) {
            showTemporaryMessage('white', 'red', 'Ollama is not available. Comments summarization will not run.');
            return;
        }

        const thread = scrapeRedditComments();
        if (!thread.comments || thread.comments.length === 0) {
            showTemporaryMessage('black', 'yellow', 'No comments found.');
            return;
        }

        function countDescendants(commentNode) {
            let count = commentNode.children.length;
            for (const child of commentNode.children) {
                count += countDescendants(child);
            }
            return count;
        }

        for (const c of thread.comments.slice(0, COMMENT_THREADS)) {
            const commentId = c.id;
            if (!commentId) continue;

            const descendantCount = countDescendants(c);
            if (descendantCount <= MIN_CHILD_COMMENTS_FOR_SUMMARY) {
                continue;
            }

            // Check database first
            const cachedSummary = await getCommentSummaryFromDB(commentId);
            if (cachedSummary) {
                const tagline = document.querySelector(`#${commentId} > .entry > .tagline`);
                if (tagline) {
                    const div = document.createElement('div');
                    div.className = 'md';
                    div.style.color = '#777';
                    div.style.marginLeft = '-1.75rem';
                    div.innerHTML = marked.parse(cachedSummary) + `<br><span style="color: #777777">Cached summary</span>`;
                    tagline.insertAdjacentElement("afterend", div);
                }
                continue;
            }

            // Generate new summary if not cached
            const cleanComments = removeIdRecursively(c);
            cleanComments.title = thread.title;
            cleanComments.subreddit = thread.subreddit;

            const payload = {
                model: OLLAMA_MODEL,
                num_ctx: 64000,
                stream: false,
                temperature: 0.75,
                messages: [
                    { "role": "system", "content": COMMENTS_SYSTEM_PROMPT },
                    { "role": "user", "content": `\`\`\`json\n${JSON.stringify(cleanComments, null, 2)}\n\`\`\`` },
                ]
            };

            try {
                const response = await makeOllamaRequest('POST', OLLAMA_CHAT_ENDPOINT, payload);
                if (response?.message?.content) {
                    const summaryContent = response.message.content;
                    const parsedHtml = marked.parse(summaryContent);

                    const tagline = document.querySelector(`#${commentId} > .entry > .tagline`);
                    if (tagline) {
                        const div = document.createElement('div');
                        div.className = 'md';
                        div.style.color = '#777';
                        div.style.marginLeft = '-1.75rem';
                        div.innerHTML = parsedHtml;
                        tagline.insertAdjacentElement("afterend", div);
                    }

                    // Save to database
                    await saveCommentSummaryToDB(commentId, summaryContent);
                }
            } catch (error) {
                showTemporaryMessage('white', 'red', 'Failed to summarize a comment: ' + error);
                console.warn(error);
            }
        }
    }

    // Run when ready
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', runCommentsSummarize);
    } else {
        runCommentsSummarize();
    }

})();
