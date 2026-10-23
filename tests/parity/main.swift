// Plays games with the app's own engine and computer (compiled from ~/code/ginrummy) and
// writes every hand as a JSON line — the deck, each move, how it ended — for
// tests/parity/parity.js to replay on the web version.
import Foundation

struct SplitMix64: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}

let games = Int(CommandLine.arguments.dropFirst().first ?? "50") ?? 50
var rng = SplitMix64(state: 2026)
func id(_ c: Card) -> Int { c.suit.rawValue * 100 + c.rank }
func encode(_ m: GinGame.Move) -> [String: Any] {
    switch m {
    case .takeUpcard: ["type": "takeUpcard"]
    case .passUpcard: ["type": "passUpcard"]
    case .drawStock: ["type": "drawStock"]
    case .drawDiscard: ["type": "drawDiscard"]
    case .discard(let c): ["type": "discard", "card": id(c)]
    case .knock(let c): ["type": "knock", "card": id(c)]
    }
}
let computer = ComputerPlayer()
for _ in 0..<games {
    var deck = Card.fullDeck.shuffled(using: &rng)
    var game = GinGame(dealer: Int.random(in: 0...1, using: &rng), deck: deck)
    while true {
        let before = game.scores, dealer = game.dealer
        var moves: [[String: Any]] = []
        while [.upcard, .drawing, .discarding].contains(game.phase) {
            let seat = game.turn
            let move = computer.move(game, as: seat)
            var m = encode(move); m["seat"] = seat
            moves.append(m)
            try! game.apply(move, by: seat)
        }
        let r = game.result!
        let line: [String: Any] = ["dealer": dealer, "deck": deck.map(id), "before": before, "moves": moves,
                    "kind": r.kind.rawValue, "points": r.points, "winner": r.winner ?? -1, "after": game.scores,
                    "deadwood": r.arrangements.map(\.deadwoodCount), "phase": game.phase.rawValue]
        print(String(data: try! JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]), encoding: .utf8)!)
        if game.phase == .gameOver { break }
        deck = Card.fullDeck.shuffled(using: &rng)
        try! game.nextHand(deck: deck)
    }
}
