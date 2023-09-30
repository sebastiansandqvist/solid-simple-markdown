/** @jsxImportSource solid-js */

import { For, type Component, type JSX, splitProps } from "solid-js";

const CR_NEWLINE_R = /\r\n?/g;
const TAB_R = /\t/g;
const FORMFEED_R = /\f/g;

function preprocess(source: string) {
  return source.replace(CR_NEWLINE_R, '\n')
    .replace(FORMFEED_R, '')
    .replace(TAB_R, '    ');
};

function populateInitialState(givenState?: State, defaultState?: State): State {
  const state: State = givenState || {};
  if (defaultState != null) {
    for (const prop in defaultState) {
      if (Object.prototype.hasOwnProperty.call(defaultState, prop)) {
        state[prop] = defaultState[prop];
      }
    }
  }
  return state;
};

function parserFor(rules: ParserRules, defaultState?: State) {
  // Sorts rules in order of increasing order, then
  // ascending rule name in case of ties.
  const ruleList = Object.keys(rules).filter(function (type) {
    const rule = rules[type];
    if (rule == null || rule.match == null) {
      return false;
    }
    const order = rule.order;
    if ((typeof order !== 'number' || !isFinite(order)) &&
      typeof console !== 'undefined') {
      console.warn(
        "simple-markdown: Invalid order for rule `" + type + "`: " +
        String(order)
      );
    }
    return true;
  });

  ruleList.sort(function (typeA, typeB) {
    const ruleA: ParserRule = rules[typeA] as any;
    const ruleB: ParserRule = rules[typeB] as any;
    const orderA = ruleA.order;
    const orderB = ruleB.order;

    // First sort based on increasing order
    if (orderA !== orderB) {
      return orderA - orderB;
    }

    const secondaryOrderA = ruleA.quality ? 0 : 1;
    const secondaryOrderB = ruleB.quality ? 0 : 1;

    if (secondaryOrderA !== secondaryOrderB) {
      return secondaryOrderA - secondaryOrderB;

      // Then based on increasing unicode lexicographic ordering
    } else if (typeA < typeB) {
      return -1;
    } else if (typeA > typeB) {
      return 1;

    } else {
      // Rules should never have the same name,
      // but this is provided for completeness.
      return 0;
    }
  });

  let latestState: State;

  const nestedParse: Parser = (source: string, state?: State) => {
    const result: SingleASTNode[] = [];
    state = state || latestState;
    latestState = state;
    while (source) {
      // store the best match, it's rule, and quality:
      let ruleType = null;
      let rule = null;
      let capture = null;
      let quality = NaN;

      // loop control variables:
      let i = 0;
      let currRuleType = ruleList[0];
      let currRule: ParserRule = rules[currRuleType!] as ParserRule;

      do {
        var currOrder = currRule.order;
        const prevCaptureStr = state.prevCapture == null ? "" : state.prevCapture[0];
        const currCapture = currRule.match(source, state, prevCaptureStr);

        if (currCapture) {
          const currQuality = currRule.quality ? currRule.quality(
            currCapture,
            state,
            prevCaptureStr
          ) : 0;
          // This should always be true the first time because
          // the initial quality is NaN (that's why there's the
          // condition negation).
          if (!(currQuality <= quality)) {
            ruleType = currRuleType;
            rule = currRule;
            capture = currCapture;
            quality = currQuality;
          }
        }

        // Move on to the next item.
        // Note that this makes `currRule` be the next item
        i++;
        currRuleType = ruleList[i];
        currRule = rules[currRuleType!] as ParserRule;

      } while (
        // keep looping while we're still within the ruleList
        currRule && (
          // if we don't have a match yet, continue
          !capture || (
            // or if we have a match, but the next rule is
            // at the same order, and has a quality measurement
            // functions, then this rule must have a quality
            // measurement function (since they are sorted before
            // those without), and we need to check if there is
            // a better quality match
            currRule.order === currOrder &&
            currRule.quality
          )
        )
      );

      // TODO(aria): Write tests for these
      if (rule == null || capture == null /*:: || ruleType == null */) {
        throw new Error(
          "Could not find a matching rule for the below " +
          "content. The rule with highest `order` should " +
          "always match content provided to it. Check " +
          "the definition of `match` for '" +
          ruleList[ruleList.length - 1] +
          "'. It seems to not match the following source:\n" +
          source
        );
      }
      if (capture.index) { // If present and non-zero, i.e. a non-^ regexp result:
        throw new Error(
          "`match` must return a capture starting at index 0 " +
          "(the current parse index). Did you forget a ^ at the " +
          "start of the RegExp?"
        );
      }

      const parsed = rule.parse(capture, nestedParse, state);
      // We maintain the same object here so that rules can
      // store references to the objects they return and
      // modify them later. (oops sorry! but this adds a lot
      // of power--see reflinks.)
      if (Array.isArray(parsed)) {
        Array.prototype.push.apply(result, parsed);
      } else {
        // We also let rules override the default type of
        // their parsed node if they would like to, so that
        // there can be a single output function for all links,
        // even if there are several rules to parse them.
        if (parsed.type == null) {
          parsed.type = ruleType;
        }
        result.push(parsed as SingleASTNode);
      }

      state.prevCapture = capture;
      source = source.substring(state.prevCapture[0].length);
    }
    return result;
  };

  const outerParse: Parser = (source: string, state?: State) => {
    latestState = populateInitialState(state, defaultState);
    if (!latestState.inline && !latestState.disableAutoBlockNewlines) {
      source = source + "\n\n";
    }
    // We store the previous capture so that match functions can
    // use some limited amount of lookbehind. Lists use this to
    // ensure they don't match arbitrary '- ' or '* ' in inline
    // text (see the list rule for more information). This stores
    // the full regex capture object, if there is one.
    latestState.prevCapture = null;
    return nestedParse(preprocess(source), latestState);
  };
  return outerParse;
};

function inlineRegex(regex: RegExp) {
  const match: MatchFunction = (source, state) => {
    if (state.inline) {
      return regex.exec(source);
    } else {
      return null;
    }
  };
  match.regex = regex;
  return match;
};

function blockRegex(regex: RegExp) {
  const match: MatchFunction = (source, state) => {
    if (state.inline) {
      return null;
    } else {
      return regex.exec(source);
    }
  };
  match.regex = regex;
  return match;
};

function anyScopeRegex(regex: RegExp) {
  const match: MatchFunction = function (source, state) {
    return regex.exec(source);
  };
  match.regex = regex;
  return match;
};

function sanitizeUrl(url?: string) {
  if (url == null) {
    return null;
  }
  try {
    const prot = new URL(url, 'https://localhost').protocol
    if (prot.indexOf('javascript:') === 0 || prot.indexOf('vbscript:') === 0 || prot.indexOf('data:') === 0) {
      return null;
    }
  } catch (e) {
    // invalid URLs should throw a TypeError
    // see for instance: `new URL("");`
    return null;
  }
  return url;
};


const UNESCAPE_URL_R = /\\([^0-9A-Za-z\s])/g;

function unescapeUrl(rawUrlString: string) {
  return rawUrlString.replace(UNESCAPE_URL_R, "$1");
};

function parseInline(parse: Parser, content: string, state: State): ASTNode {
  const isCurrentlyInline = state.inline || false;
  state.inline = true;
  const result = parse(content, state);
  state.inline = isCurrentlyInline;
  return result;
};

// function parseBlock(parse: Parser, content: string, state: State): ASTNode {
//   const isCurrentlyInline = state.inline || false;
//   state.inline = false;
//   const result = parse(content + "\n\n", state);
//   state.inline = isCurrentlyInline;
//   return result;
// };

function parseCaptureInline(capture: Capture, parse: Parser, state: State): UnTypedASTNode {
  return {
    content: parseInline(parse, capture[1]!, state)
  };
};

function ignoreCapture(): UnTypedASTNode { return {}; };

// recognize a `*` `-`, `+`, `1.`, `2.`... list bullet
const LIST_BULLET = "(?:[*+-]|\\d+\\.)";
// recognize the start of a list item:
// leading space plus a bullet plus a space (`   * `)
const LIST_ITEM_PREFIX = "( *)(" + LIST_BULLET + ") +";
const LIST_ITEM_PREFIX_R = new RegExp("^" + LIST_ITEM_PREFIX);
// recognize an individual list item:
//  * hi
//    this is part of the same item
//
//    as is this, which is a new paragraph in the same item
//
//  * but this is not part of the same item
const LIST_ITEM_R = new RegExp(
  LIST_ITEM_PREFIX +
  "[^\\n]*(?:\\n" +
  "(?!\\1" + LIST_BULLET + " )[^\\n]*)*(\n|$)",
  "gm"
);
const BLOCK_END_R = /\n{2,}$/;
const INLINE_CODE_ESCAPE_BACKTICKS_R = /^ (?= *`)|(` *) $/g;
// recognize the end of a paragraph block inside a list item:
// two or more newlines at end end of the item
const LIST_BLOCK_END_R = BLOCK_END_R;
const LIST_ITEM_END_R = / *\n+$/;
// check whether a list item has paragraphs: if it does,
// we leave the newlines at the end
const LIST_R = new RegExp(
  "^( *)(" + LIST_BULLET + ") " +
  "[\\s\\S]+?(?:\n{2,}(?! )" +
  "(?!\\1" + LIST_BULLET + " )\\n*" +
  // the \\s*$ here is so that we can parse the inside of nested
  // lists, where our content might end before we receive two `\n`s
  "|\\s*\n*$)"
);
const LIST_LOOKBEHIND_R = /(?:^|\n)( *)$/;



const TABLES = (() => {
  // predefine regexes so we don't have to create them inside functions
  // sure, regex literals should be fast, even inside functions, but they
  // aren't in all browsers.
  // const TABLE_BLOCK_TRIM = /\n+/g;
  const TABLE_ROW_SEPARATOR_TRIM = /^ *\| *| *\| *$/g;
  const TABLE_CELL_END_TRIM = / *$/;
  const TABLE_RIGHT_ALIGN = /^ *-+: *$/;
  const TABLE_CENTER_ALIGN = /^ *:-+: *$/;
  const TABLE_LEFT_ALIGN = /^ *:-+ *$/;

  const parseTableAlignCapture = (alignCapture: string): TableAlignment => {
    if (TABLE_RIGHT_ALIGN.test(alignCapture)) {
      return "right";
    } else if (TABLE_CENTER_ALIGN.test(alignCapture)) {
      return "center";
    } else if (TABLE_LEFT_ALIGN.test(alignCapture)) {
      return "left";
    } else {
      return null;
    }
  };

  const parseTableAlign = (source: string, parse: Parser, state: State, trimEndSeparators: boolean): TableAlignment[] => {
    if (trimEndSeparators) {
      source = source.replace(TABLE_ROW_SEPARATOR_TRIM, "");
    }
    const alignText = source.trim().split("|");
    return alignText.map(parseTableAlignCapture);
  };

  const parseTableRow = (source: string, parse: Parser, state: State, trimEndSeparators: boolean): SingleASTNode[][] => {
    const prevInTable = state.inTable;
    state.inTable = true;
    const tableRow = parse(source.trim(), state);
    state.inTable = prevInTable;

    const cells: SingleASTNode[][] = [[]];
    tableRow.forEach(function (node, i) {
      if (node.type === 'tableSeparator') {
        // Filter out empty table separators at the start/end:
        if (!trimEndSeparators || i !== 0 && i !== tableRow.length - 1) {
          // Split the current row:
          cells.push([]);
        }
      } else {
        if (node.type === 'text' && (
          tableRow[i + 1] == null ||
          tableRow[i + 1]!.type === 'tableSeparator'
        )) {
          node.content = node.content.replace(TABLE_CELL_END_TRIM, "");
        }
        cells[cells.length - 1]!.push(node);
      }
    });

    return cells;
  };

  const parseTableCells = (source: string, parse: Parser, state: State, trimEndSeparators: boolean): ASTNode[][] => {
    const rowsText = source.trim().split("\n");

    return rowsText.map((rowText) => {
      return parseTableRow(rowText, parse, state, trimEndSeparators);
    });
  };

  const parseTable = (trimEndSeparators: boolean): SingleNodeParseFunction => {
    return function (capture, parse, state) {
      state.inline = true;
      const header = parseTableRow(capture[1]!, parse, state, trimEndSeparators);
      const align = parseTableAlign(capture[2]!, parse, state, trimEndSeparators);
      const cells = parseTableCells(capture[3]!, parse, state, trimEndSeparators);
      state.inline = false;

      return {
        type: "table",
        header: header,
        align: align,
        cells: cells
      };
    };
  };

  return {
    parseTable: parseTable(true),
    parseNpTable: parseTable(false),
    TABLE_REGEX: /^ *(\|.+)\n *\|( *[-:]+[-| :]*)\n((?: *\|.*(?:\n|$))*)\n*/,
    NPTABLE_REGEX: /^ *(\S.*\|.*)\n *([-:]+ *\|[-| :]*)\n((?:.*\|.*(?:\n|$))*)\n*/
  };
})();

const LINK_INSIDE = "(?:\\[[^\\]]*\\]|[^\\[\\]]|\\](?=[^\\[]*\\]))*";
const LINK_HREF_AND_TITLE = "\\s*<?((?:\\([^)]*\\)|[^\\s\\\\]|\\\\.)*?)>?(?:\\s+['\"]([\\s\\S]*?)['\"])?\\s*";
const AUTOLINK_MAILTO_CHECK_R = /mailto:/i;


function parseRef(capture: Capture, state: State, refNode: RefNode): RefNode {
  const ref = (capture[2]! || capture[1]!)
    .replace(/\s+/g, ' ')
    .toLowerCase();

  // We store information about previously seen defs on
  // state._defs (_ to deconflict with client-defined
  // state). If the def for this reflink/refimage has
  // already been seen, we can use its target/source
  // and title here:
  if (state._defs && state._defs[ref]) {
    const def = state._defs[ref];
    // `refNode` can be a link or an image. Both use
    // target and title properties.
    refNode.target = def.target;
    refNode.title = def.title;
  }

  // In case we haven't seen our def yet (or if someone
  // overwrites that def later on), we add this node
  // to the list of ref nodes for that def. Then, when
  // we find the def, we can modify this link/image AST
  // node :).
  // I'm sorry.
  state._refs = state._refs || {};
  state._refs[ref] = state._refs[ref] || [];
  state._refs[ref].push(refNode);

  return refNode;
};

let currOrder = 0;


const defaultRules: DefaultRules = {
  Array: {
    solid: function (arr, output, state) {
      const oldKey = state.key;
      const result: JSX.Element = [];

      // map output over the ast, except group any text
      // nodes together into a single string output.
      for (let i = 0, key = 0; i < arr.length; i++, key++) {
        // `key` is our numerical `state.key`, which we increment for
        // every output node, but don't change for joined text nodes.
        // (i, however, must change for joined text nodes)
        state.key = '' + i;

        let node = arr[i]!;
        if (node.type === 'text') {
          node = { type: 'text', content: node.content };
          for (; i + 1 < arr.length && arr[i + 1]!.type === 'text'; i++) {
            node.content += arr[i + 1]!.content;
          }
        }

        result.push(output(node, state));
      }

      state.key = oldKey;
      return result;
    },
  },
  heading: {
    order: currOrder++,
    match: blockRegex(/^ *(#{1,6})([^\n]+?)#* *(?:\n *)+\n/),
    parse: function (capture, parse, state) {
      return {
        level: capture[1]!.length,
        content: parseInline(parse, capture[2]!.trim(), state)
      };
    },
    solid: function (node, output, state) {
      switch (node.level) {
        case 1: return <h1>{output(node.content, state)}</h1>
        case 2: return <h2>{output(node.content, state)}</h2>
        case 3: return <h3>{output(node.content, state)}</h3>
        case 4: return <h4>{output(node.content, state)}</h4>
        case 5: return <h5>{output(node.content, state)}</h5>
        case 6: return <h6>{output(node.content, state)}</h6>
        default: return <p>{output(node.content, state)}</p>
      }
    },
  },
  nptable: {
    order: currOrder++,
    match: blockRegex(TABLES.NPTABLE_REGEX),
    parse: TABLES.parseNpTable,
    solid: null,
  },
  lheading: {
    order: currOrder++,
    match: blockRegex(/^([^\n]+)\n *(=|-){3,} *(?:\n *)+\n/),
    parse: function (capture, parse, state) {
      return {
        type: "heading",
        level: capture[2] === '=' ? 1 : 2,
        content: parseInline(parse, capture[1]!, state)
      };
    },
    solid: null,
  },
  hr: {
    order: currOrder++,
    match: blockRegex(/^( *[-*_]){3,} *(?:\n *)+\n/),
    parse: ignoreCapture,
    solid: function (node, output, state) {
      return <hr />
    },
  },
  codeBlock: {
    order: currOrder++,
    match: blockRegex(/^(?:    [^\n]+\n*)+(?:\n *)+\n/),
    parse: function (capture, parse, state) {
      const content = capture[0]!
        .replace(/^    /gm, '')
        .replace(/\n+$/, '');
      return {
        lang: undefined,
        content: content
      };
    },
    solid: function (node, output, state) {
      const className = node.lang ?
        "markdown-code-" + node.lang :
        undefined;

      return <pre><code class={className}>{node.content}</code></pre>;
    },
  },
  fence: {
    order: currOrder++,
    match: blockRegex(/^ *(`{3,}|~{3,}) *(?:(\S+) *)?\n([\s\S]+?)\n?\1 *(?:\n *)+\n/),
    parse: function (capture, parse, state) {
      return {
        type: "codeBlock",
        lang: capture[2] || undefined,
        content: capture[3]
      };
    },
    solid: null,
  },
  blockQuote: {
    order: currOrder++,
    match: blockRegex(/^( *>[^\n]+(\n[^\n]+)*\n*)+\n{2,}/),
    parse: function (capture, parse, state) {
      const content = capture[0]!.replace(/^ *> ?/gm, '');
      return {
        content: parse(content, state)
      };
    },
    solid: function (node, output, state) {
      return <blockquote>{output(node.content, state)}</blockquote>;
    },
  },
  list: {
    order: currOrder++,
    match: function (source, state) {
      // We only want to break into a list if we are at the start of a
      // line. This is to avoid parsing "hi * there" with "* there"
      // becoming a part of a list.
      // You might wonder, "but that's inline, so of course it wouldn't
      // start a list?". You would be correct! Except that some of our
      // lists can be inline, because they might be inside another list,
      // in which case we can parse with inline scope, but need to allow
      // nested lists inside this inline scope.
      const prevCaptureStr = state.prevCapture == null ? "" : state.prevCapture[0];
      const isStartOfLineCapture = LIST_LOOKBEHIND_R.exec(prevCaptureStr);
      const isListBlock = state._list || !state.inline;

      if (isStartOfLineCapture && isListBlock) {
        source = isStartOfLineCapture[1] + source;
        return LIST_R.exec(source);
      } else {
        return null;
      }
    },
    parse: function (capture, parse, state) {
      const bullet = capture[2]!;
      const ordered = bullet.length > 1;
      const start = ordered ? +bullet : undefined;
      const items: string[] = (
        capture[0]!
          .replace(LIST_BLOCK_END_R, "\n")
          .match(LIST_ITEM_R)!
      );

      // We know this will match here, because of how the regexes are
      // defined

      let lastItemWasAParagraph = false;
      const itemContent = items.map(function (item, i) {
        // We need to see how far indented this item is:
        const prefixCapture = LIST_ITEM_PREFIX_R.exec(item);
        const space = prefixCapture ? prefixCapture[0].length : 0;
        // And then we construct a regex to "unindent" the subsequent
        // lines of the items by that amount:
        const spaceRegex = new RegExp("^ {1," + space + "}", "gm");

        // Before processing the item, we need a couple things
        const content = item
          // remove indents on trailing lines:
          .replace(spaceRegex, '')
          // remove the bullet:
          .replace(LIST_ITEM_PREFIX_R, '');

        // I'm not sur4 why this is necessary again?
        /*:: items = ((items : any) : Array<string>) */

        // Handling "loose" lists, like:
        //
        //  * this is wrapped in a paragraph
        //
        //  * as is this
        //
        //  * as is this
        const isLastItem = (i === items.length - 1);
        const containsBlocks = content.indexOf("\n\n") !== -1;

        // Any element in a list is a block if it contains multiple
        // newlines. The last element in the list can also be a block
        // if the previous item in the list was a block (this is
        // because non-last items in the list can end with \n\n, but
        // the last item can't, so we just "inherit" this property
        // from our previous element).
        const thisItemIsAParagraph = containsBlocks ||
          (isLastItem && lastItemWasAParagraph);
        lastItemWasAParagraph = thisItemIsAParagraph;

        // backup our state for restoration afterwards. We're going to
        // want to set state._list to true, and state.inline depending
        // on our list's looseness.
        const oldStateInline = state.inline;
        const oldStateList = state._list;
        state._list = true;

        // Parse inline if we're in a tight list, or block if we're in
        // a loose list.
        let adjustedContent;
        if (thisItemIsAParagraph) {
          state.inline = false;
          adjustedContent = content.replace(LIST_ITEM_END_R, "\n\n");
        } else {
          state.inline = true;
          adjustedContent = content.replace(LIST_ITEM_END_R, "");
        }

        const result = parse(adjustedContent, state);

        // Restore our state before returning
        state.inline = oldStateInline;
        state._list = oldStateList;
        return result;
      });

      return {
        ordered: ordered,
        start: start,
        items: itemContent
      };
    },
    solid: function (node, output, state) {
      const ListWrapper = node.ordered ? "ol" : "ul";

      return <ListWrapper>
        <For each={node.items as ASTNode[]}>
          {(item) => <li>{output(item, state)}</li>}
        </For>
      </ListWrapper>;
    },
  },
  def: {
    order: currOrder++,
    // TODO(aria): This will match without a blank line before the next
    // block element, which is inconsistent with most of the rest of
    // simple-markdown.
    match: blockRegex(
      /^ *\[([^\]]+)\]: *<?([^\s>]*)>?(?: +["(]([^\n]+)[")])? *\n(?: *\n)*/
    ),
    parse: function (capture, parse, state) {
      const def = capture[1]!
        .replace(/\s+/g, ' ')
        .toLowerCase();
      const target = capture[2];
      const title = capture[3];

      // Look for previous links/images using this def
      // If any links/images using this def have already been declared,
      // they will have added themselves to the state._refs[def] list
      // (_ to deconflict with client-defined state). We look through
      // that list of reflinks for this def, and modify those AST nodes
      // with our newly found information now.
      // Sorry :(.
      if (state._refs && state._refs[def]) {
        // `refNode` can be a link or an image
        state._refs[def].forEach(function (refNode: RefNode) {
          refNode.target = target;
          refNode.title = title;
        });
      }

      // Add this def to our map of defs for any future links/images
      // In case we haven't found any or all of the refs referring to
      // this def yet, we add our def to the table of known defs, so
      // that future reflinks can modify themselves appropriately with
      // this information.
      state._defs = state._defs || {};
      state._defs[def] = {
        target: target,
        title: title,
      };

      // return the relevant parsed information
      // for debugging only.
      return {
        def: def,
        target: target,
        title: title,
      };
    },
    solid: function () { return null; },
  },
  table: {
    order: currOrder++,
    match: blockRegex(TABLES.TABLE_REGEX),
    parse: TABLES.parseTable,
    solid: function (node, output, state) {
      const getStyle = (colIndex: number): JSX.CSSProperties => {
        return node.align[colIndex] == null ? {} : {
          "text-align": node.align[colIndex]
        };
      };

      const headers = node.header.map((content: ASTNode, i: number) => {
        return <th style={getStyle(i)} scope="col">{output(content, state)}</th>;
      });

      const rows = node.cells.map((row: ASTNode[], r: number) => {
        return (
          <tr>
            <For each={row}>
              {(content, c) => (
                <td style={getStyle(c())}>{output(content, state)}</td>
              )}
            </For>
          </tr>
        );
      });

      return (
        <table>
          <thead>
            <tr>{headers}</tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      );
    },
  },
  newline: {
    order: currOrder++,
    match: blockRegex(/^(?:\n *)*\n/),
    parse: ignoreCapture,
    solid: function (node, output, state) { return "\n"; },
  },
  paragraph: {
    order: currOrder++,
    match: blockRegex(/^((?:[^\n]|\n(?! *\n))+)(?:\n *)+\n/),
    parse: parseCaptureInline,
    solid: function (node, output, state) {
      return <div class="paragraph">{output(node.content, state)}</div>
    },
  },
  escape: {
    order: currOrder++,
    // We don't allow escaping numbers, letters, or spaces here so that
    // backslashes used in plain text still get rendered. But allowing
    // escaping anything else provides a very flexible escape mechanism,
    // regardless of how this grammar is extended.
    match: inlineRegex(/^\\([^0-9A-Za-z\s])/),
    parse: function (capture, parse, state) {
      return {
        type: "text",
        content: capture[1]
      };
    },
    solid: null,
  },
  tableSeparator: {
    order: currOrder++,
    match: function (source, state) {
      if (!state.inTable) {
        return null;
      }
      return /^ *\| */.exec(source);
    },
    parse: function () {
      return { type: 'tableSeparator' };
    },
    // These shouldn't be reached, but in case they are, be reasonable:
    solid: function () { return ' | '; },
  },
  autolink: {
    order: currOrder++,
    match: inlineRegex(/^<([^: >]+:\/[^ >]+)>/),
    parse: function (capture, parse, state) {
      return {
        type: "link",
        content: [{
          type: "text",
          content: capture[1]
        }],
        target: capture[1]
      };
    },
    solid: null,
  },
  mailto: {
    order: currOrder++,
    match: inlineRegex(/^<([^ >]+@[^ >]+)>/),
    parse: function (capture, parse, state) {
      const address = capture[1];
      let target = capture[1]!;

      // Check for a `mailto:` already existing in the link:
      if (!AUTOLINK_MAILTO_CHECK_R.test(target)) {
        target = "mailto:" + target;
      }

      return {
        type: "link",
        content: [{
          type: "text",
          content: address
        }],
        target: target
      };
    },
    solid: null,
  },
  url: {
    order: currOrder++,
    match: inlineRegex(/^(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/),
    parse: function (capture, parse, state) {
      return {
        type: "link",
        content: [{
          type: "text",
          content: capture[1]
        }],
        target: capture[1],
        title: undefined
      };
    },
    solid: null,
  },
  link: {
    order: currOrder++,
    match: inlineRegex(new RegExp(
      "^\\[(" + LINK_INSIDE + ")\\]\\(" + LINK_HREF_AND_TITLE + "\\)"
    )),
    parse: function (capture, parse, state) {
      const link = {
        content: parse(capture[1]!, state),
        target: unescapeUrl(capture[2]!),
        title: capture[3]
      };
      return link;
    },
    solid: function (node, output, state) {
      return <a title={node.title} href={sanitizeUrl(node.target)!}>{output(node.content, state)}</a>;
    },
  },
  image: {
    order: currOrder++,
    match: inlineRegex(new RegExp(
      "^!\\[(" + LINK_INSIDE + ")\\]\\(" + LINK_HREF_AND_TITLE + "\\)"
    )),
    parse: function (capture, parse, state) {
      const image = {
        alt: capture[1],
        target: unescapeUrl(capture[2]!),
        title: capture[3]
      };
      return image;
    },
    solid: function (node, output, state) {
      return <img src={sanitizeUrl(node.target)!} alt={node.alt} title={node.title} />
    },
  },
  reflink: {
    order: currOrder++,
    match: inlineRegex(new RegExp(
      // The first [part] of the link
      "^\\[(" + LINK_INSIDE + ")\\]" +
      // The [ref] target of the link
      "\\s*\\[([^\\]]*)\\]"
    )),
    parse: function (capture, parse, state) {
      return parseRef(capture, state, {
        type: "link",
        content: parse(capture[1]!, state)
      });
    },
    solid: null,
  },
  refimage: {
    order: currOrder++,
    match: inlineRegex(new RegExp(
      // The first [part] of the link
      "^!\\[(" + LINK_INSIDE + ")\\]" +
      // The [ref] target of the link
      "\\s*\\[([^\\]]*)\\]"
    )),
    parse: function (capture, parse, state) {
      return parseRef(capture, state, {
        type: "image",
        alt: capture[1]
      });
    },
    solid: null,
  },
  em: {
    order: currOrder /* same as strong/u */,
    match: inlineRegex(
      new RegExp(
        // only match _s surrounding words.
        "^\\b_" +
        "((?:__|\\\\[\\s\\S]|[^\\\\_])+?)_" +
        "\\b" +
        // Or match *s:
        "|" +
        // Only match *s that are followed by a non-space:
        "^\\*(?=\\S)(" +
        // Match at least one of:
        "(?:" +
        //  - `**`: so that bolds inside italics don't close the
        //          italics
        "\\*\\*|" +
        //  - escape sequence: so escaped *s don't close us
        "\\\\[\\s\\S]|" +
        //  - whitespace: followed by a non-* (we don't
        //          want ' *' to close an italics--it might
        //          start a list)
        "\\s+(?:\\\\[\\s\\S]|[^\\s\\*\\\\]|\\*\\*)|" +
        //  - non-whitespace, non-*, non-backslash characters
        "[^\\s\\*\\\\]" +
        ")+?" +
        // followed by a non-space, non-* then *
        ")\\*(?!\\*)"
      )
    ),
    quality: function (capture) {
      // precedence by length, `em` wins ties:
      return capture[0]!.length + 0.2;
    },
    parse: function (capture, parse, state) {
      return {
        content: parse(capture[2] || capture[1]!, state)
      };
    },
    solid: function (node, output, state) {
      return <em>{output(node.content, state)}</em>
    }
  },
  strong: {
    order: currOrder /* same as em */,
    match: inlineRegex(/^\*\*((?:\\[\s\S]|[^\\])+?)\*\*(?!\*)/),
    quality: function (capture) {
      // precedence by length, wins ties vs `u`:
      return capture[0]!.length + 0.1;
    },
    parse: parseCaptureInline,
    solid: function (node, output, state) {
      return <strong>{output(node.content, state)}</strong>
    },
  },
  u: {
    order: currOrder++ /* same as em&strong; increment for next rule */,
    match: inlineRegex(/^__((?:\\[\s\S]|[^\\])+?)__(?!_)/),
    quality: function (capture) {
      // precedence by length, loses all ties
      return capture[0]!.length;
    },
    parse: parseCaptureInline,
    solid: function (node, output, state) {
      return <u>{output(node.content, state)}</u>
    },
  },
  del: {
    order: currOrder++,
    match: inlineRegex(/^~~(?=\S)((?:\\[\s\S]|~(?!~)|[^\s~\\]|\s(?!~~))+?)~~/),
    parse: parseCaptureInline,
    solid: function (node, output, state) {
      return <del>{output(node.content, state)}</del>
    },
  },
  inlineCode: {
    order: currOrder++,
    match: inlineRegex(/^(`+)([\s\S]*?[^`])\1(?!`)/),
    parse: function (capture, parse, state) {
      return {
        content: capture[2]!.replace(INLINE_CODE_ESCAPE_BACKTICKS_R, "$1")
      };
    },
    solid: function (node, output, state) {
      return <code>{node.content}</code>
    },
  },
  br: {
    order: currOrder++,
    match: anyScopeRegex(/^ {2,}\n/),
    parse: ignoreCapture,
    solid: function (node, output, state) {
      return <br />;
    },
  },
  text: {
    order: currOrder++,
    // Here we look for anything followed by non-symbols,
    // double newlines, or double-space-newlines
    // We break on any symbol characters so that this grammar
    // is easy to extend without needing to modify this regex
    match: anyScopeRegex(
      /^[\s\S]+?(?=[^0-9A-Za-z\s\u00c0-\uffff]|\n\n| {2,}\n|\w+:\S|$)/
    ),
    parse: function (capture, parse, state) {
      return {
        content: capture[0]
      };
    },
    solid: function (node, output, state) {
      return node.content;
    },
  }
};




const outputFor: OutputFor = (
  rules,
  property,
  defaultState,
) => {
  if (!property) {
    throw new Error('simple-markdown: outputFor: `property` must be ' +
      'defined. ' +
      'if you just upgraded, you probably need to replace `outputFor` ' +
      'with `reactFor`'
    );
  }

  let latestState: State;
  const arrayRule = rules.Array || defaultRules.Array;

  // Tricks to convince tsc that this var is not null:
  const arrayRuleCheck = arrayRule[property];
  if (!arrayRuleCheck) {
    throw new Error('simple-markdown: outputFor: to join nodes of type `' +
      property + '` you must provide an `Array:` joiner rule with that type, ' +
      'Please see the docs for details on specifying an Array rule.'
    );
  }
  const arrayRuleOutput = arrayRuleCheck;

  const nestedOutput: Output<any> = function (ast, state) {
    state = state || latestState;
    latestState = state;
    if (Array.isArray(ast)) {
      return arrayRuleOutput(ast, nestedOutput, state);
    } else {
      // TODO: fix this type.
      return (rules[ast.type] as any)[property](ast, nestedOutput, state);
    }
  };

  const outerOutput: Output<any> = function (ast, state) {
    latestState = populateInitialState(state, defaultState);
    return nestedOutput(ast, latestState);
  };
  return outerOutput;
};

const defaultRawParse = parserFor(defaultRules);

function defaultBlockParse(source: string, state: OptionalState): SingleASTNode[] {
  state = state || {};
  state.inline = false;
  return defaultRawParse(source, state);
};

// function defaultInlineParse(source: string, state: OptionalState): SingleASTNode[] {
//   state = state || {};
//   state.inline = true;
//   return defaultRawParse(source, state);
// };

// function defaultImplicitParse(source: string, state: OptionalState): SingleASTNode[] {
//   const isBlock = BLOCK_END_R.test(source);
//   state = state || {};
//   state.inline = !isBlock;
//   return defaultRawParse(source, state);
// };

const defaultSolidOutput: SolidOutput = outputFor(defaultRules, "solid");

function markdownToSolid(source: string, state: OptionalState): JSX.Element {
  return defaultSolidOutput(defaultBlockParse(source, state), state);
};


interface SolidMarkdownProps extends JSX.HTMLAttributes<HTMLDivElement> {
  source: string;
}

export const SolidMarkdown: Component<SolidMarkdownProps> = (allProps) => {
  const [{ source }, props] = splitProps(allProps, ['source']);
  return <div {...props}>{markdownToSolid(source, undefined)}</div>;
};







interface Capture extends Array<string> {
  index?: number,
  input?: string,
}

type TableAlignment = "right" | "center" | "left" | null;

interface SingleASTNode {
  type: string,
  [prop: string]: any,
}

interface UnTypedASTNode {
  [prop: string]: any
}

type ASTNode = SingleASTNode | Array<SingleASTNode>;

interface State {
  key?: string | number | undefined;
  inline?: boolean | undefined;
  [prop: string]: any,
}
type OptionalState = State | undefined;

interface MatchFunction {
  (source: string, state: State, prevCapture: string): Capture | null,
  regex?: RegExp,
}

type Parser = (
  source: string,
  state?: OptionalState,
) => Array<SingleASTNode>;

type ParseFunction = (
  capture: Capture,
  nestedParse: Parser,
  state: State,
) => (UnTypedASTNode | ASTNode);

type SingleNodeParseFunction = (
  capture: Capture,
  nestedParse: Parser,
  state: State,
) => UnTypedASTNode;

type Output<Result> = (
  node: ASTNode,
  state?: OptionalState
) => Result;

type RefiningNodeOutput<Input, Result extends Input> = (
  node: SingleASTNode,
  nestedOutput: Output<Input>,
  state: State
) => Result;

type NodeOutput<Result> = RefiningNodeOutput<Result, Result>;

type ArrayNodeOutput<Result> = (
  node: Array<SingleASTNode>,
  nestedOutput: Output<Result>,
  state: State
) => Result;

type SolidOutput = Output<JSX.Element>;
type SolidNodeOutput = NodeOutput<JSX.Element>;
type HtmlOutput = Output<string>;
type HtmlNodeOutput = NodeOutput<string>;

interface ParserRule {
  readonly order: number,
  readonly match: MatchFunction,
  readonly quality?: (capture: Capture, state: State, prevCapture: string) => number,
  readonly parse: ParseFunction,
}

interface SingleNodeParserRule extends ParserRule {
  readonly order: number,
  readonly match: MatchFunction,
  readonly quality?: (capture: Capture, state: State, prevCapture: string) => number,
  readonly parse: SingleNodeParseFunction,
}

interface SolidOutputRule {
  // we allow null because some rules are never output results, and that's
  // legal as long as no parsers return an AST node matching that rule.
  // We don't use ? because this makes it be explicitly defined as either
  // a valid function or null, so it can't be forgotten.
  readonly solid: SolidNodeOutput | null,
}


interface ArrayRule {
  readonly solid?: ArrayNodeOutput<JSX.Element>,
  readonly [other: string]: ArrayNodeOutput<any> | undefined,
}
interface SolidArrayRule extends ArrayRule {
  readonly solid: ArrayNodeOutput<JSX.Element>,
  readonly [other: string]: ArrayNodeOutput<any> | undefined,
}
interface HtmlArrayRule extends ArrayRule {
  readonly solid?: ArrayNodeOutput<JSX.Element>,
  readonly [other: string]: ArrayNodeOutput<any> | undefined,
}
interface DefaultArrayRule extends ArrayRule {
  readonly solid: ArrayNodeOutput<JSX.Element>,
}

interface ParserRules {
  readonly Array?: ArrayRule,
  readonly [type: string]: ParserRule | /* only for Array: */ ArrayRule | undefined,
}

interface OutputRules<Rule> {
  readonly Array?: ArrayRule,
  readonly [type: string]: Rule | /* only for Array: */ ArrayRule | undefined,
}
interface Rules<OutputRule> {
  readonly Array?: ArrayRule,
  readonly [type: string]: ParserRule & OutputRule | /* only for Array: */ ArrayRule | undefined,
}
interface SolidRules {
  readonly Array?: SolidArrayRule,
  readonly [type: string]: ParserRule & SolidOutputRule | SolidArrayRule | undefined,
}

// We want to clarify our defaultRules types a little bit more so clients can
// reuse defaultRules built-ins. So we make some stronger guarantess when
// we can:
interface NonNullSolidOutputRule extends SolidOutputRule {
  readonly solid: SolidNodeOutput,
}
interface ElementSolidOutputRule extends SolidOutputRule {
  readonly solid: RefiningNodeOutput<JSX.Element, JSX.Element>,
}
interface TextSolidOutputRule extends SolidOutputRule {
  readonly solid: RefiningNodeOutput<JSX.Element, string>,
}

type DefaultInRule = SingleNodeParserRule & SolidOutputRule;
type TextInOutRule = SingleNodeParserRule & TextSolidOutputRule;
type LenientInOutRule = SingleNodeParserRule & NonNullSolidOutputRule;
type DefaultInOutRule = SingleNodeParserRule & ElementSolidOutputRule;

interface DefaultRules extends SolidRules {
  readonly Array: DefaultArrayRule,
  readonly heading: DefaultInOutRule,
  readonly nptable: DefaultInRule,
  readonly lheading: DefaultInRule,
  readonly hr: DefaultInOutRule,
  readonly codeBlock: DefaultInOutRule,
  readonly fence: DefaultInRule,
  readonly blockQuote: DefaultInOutRule,
  readonly list: DefaultInOutRule,
  readonly def: LenientInOutRule,
  readonly table: DefaultInOutRule,
  readonly tableSeparator: DefaultInRule,
  readonly newline: TextInOutRule,
  readonly paragraph: DefaultInOutRule,
  readonly escape: DefaultInRule,
  readonly autolink: DefaultInRule,
  readonly mailto: DefaultInRule,
  readonly url: DefaultInRule,
  readonly link: DefaultInOutRule,
  readonly image: DefaultInOutRule,
  readonly reflink: DefaultInRule,
  readonly refimage: DefaultInRule,
  readonly em: DefaultInOutRule,
  readonly strong: DefaultInOutRule,
  readonly u: DefaultInOutRule,
  readonly del: DefaultInOutRule,
  readonly inlineCode: DefaultInOutRule,
  readonly br: DefaultInOutRule,
  readonly text: TextInOutRule,
}

interface RefNode {
  type: string,
  content?: ASTNode,
  target?: string,
  title?: string,
  alt?: string,
}

type OutputFor = <Rule extends Object>(
  rules: OutputRules<Rule>,
  property: 'solid',
  defaultState?: OptionalState
) => Output<any>;

