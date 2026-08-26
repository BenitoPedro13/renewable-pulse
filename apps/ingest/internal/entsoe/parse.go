// Package entsoe fetches and normalizes ENTSO-E's "Actual generation per
// type" dataset (document type A75, process type A16) for Norway's bidding
// zones (docs/architecture.md §3).
//
// Namespaces are intentionally not declared on the struct tags below: ENTSO-E
// has shipped minor namespace-URI revisions across document-type versions,
// and matching on local element name only (the same approach entsoe-py takes
// via BeautifulSoup) is more robust to that than pinning one exact URI.
package entsoe

import "encoding/xml"

// glMarketDocument is ENTSO-E's response for a successful generation query.
type glMarketDocument struct {
	XMLName    xml.Name     `xml:"GL_MarketDocument"`
	TimeSeries []timeSeries `xml:"TimeSeries"`
}

type timeSeries struct {
	MktPSRType struct {
		PsrType string `xml:"psrType"`
	} `xml:"MktPSRType"`
	InBiddingZone  string   `xml:"inBiddingZone_Domain.mRID"`
	OutBiddingZone string   `xml:"outBiddingZone_Domain.mRID"`
	Periods        []period `xml:"Period"`
}

type period struct {
	TimeInterval struct {
		Start string `xml:"start"`
		End   string `xml:"end"`
	} `xml:"timeInterval"`
	Resolution string  `xml:"resolution"`
	Points     []point `xml:"Point"`
}

type point struct {
	Position int     `xml:"position"`
	Quantity float64 `xml:"quantity"`
}

// acknowledgementMarketDocument is ENTSO-E's response when a query has no
// data or is otherwise rejected — a real GL_MarketDocument is never returned
// alongside this, so the two are mutually exclusive root elements.
type acknowledgementMarketDocument struct {
	XMLName xml.Name `xml:"Acknowledgement_MarketDocument"`
	Reason  struct {
		Code string `xml:"code"`
		Text string `xml:"text"`
	} `xml:"Reason"`
}
