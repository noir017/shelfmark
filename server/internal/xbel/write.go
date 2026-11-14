package xbel

import (
	"bytes"
	"strconv"
	"strings"
)

var escaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")

// Write renders items exactly like Floccus' createXBEL (fast-xml-parser
// XMLBuilder with format: true, two-space indentation).
func Write(items []*Item, highestID int64) []byte {
	var b bytes.Buffer
	b.WriteString(Header + "\n")
	b.WriteString(`<!DOCTYPE xbel PUBLIC "+//IDN python.org//DTD XML Bookmark Exchange Language 1.0//EN//XML" "http://pyxml.sourceforge.net/topics/dtds/xbel.dtd">` + "\n")
	b.WriteString(`<xbel version="1.0">` + "\n")
	b.WriteString("<!--- highestId :" + strconv.FormatInt(highestID, 10) + ": for Floccus bookmark sync browser extension -->\n")
	writeItems(&b, items, 0)
	b.WriteString("\n</xbel>")
	return b.Bytes()
}

func writeItems(b *bytes.Buffer, items []*Item, depth int) {
	indent := strings.Repeat("  ", depth)
	inner := indent + "  "
	for _, it := range items {
		b.WriteString("\n" + indent)
		if it.Type == TypeBookmark {
			b.WriteString(`<bookmark href="` + escaper.Replace(it.URL) + `" id="` + strconv.FormatInt(it.ID, 10) + `">`)
			b.WriteString("\n" + inner + "<title>" + escaper.Replace(it.Title) + "</title>")
			b.WriteString("\n" + indent + "</bookmark>")
			continue
		}
		b.WriteString(`<folder id="` + strconv.FormatInt(it.ID, 10) + `">`)
		b.WriteString("\n" + inner + "<title>" + escaper.Replace(it.Title) + "</title>")
		writeItems(b, it.Children, depth+1)
		b.WriteString("\n" + indent + "</folder>")
	}
}
