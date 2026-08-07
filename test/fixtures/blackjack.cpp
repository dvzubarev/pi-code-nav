/**
 * The black jack code is from the youtube channel Dave's Garage.
 * Here is the link to the video: https://youtu.be/b8V-WIjlScA 
 * Give him a like and subscribe, he makes great content.
 *
 * The link to Daves repository with the original code is here: https://github.com/davepl/blackjack
 *
 * In the video Dave does some manual iteration over a C style enum.
 * At the time stamp 8:30 he says "One unfortunate part about C++
 * is that it doesn't provide a way to get the lowest and highest values in an enumeration".
 * Which he is correct. However it is quite easily done, so I decided to write a template
 * class that can provide this functionality for basically any contigious enum class and use his black jack code
 * to show case it.
 * 
 * For fun I also modernized a bit more of the code, with attributes like nodiscard and maybe_unused, 
 * trailing return types, and std::optional<T>.
 *
 * The code can be compiled with the follwing contents in a Makefile
 * You will need to compile with c++ >= 17.
 *
 * ```
 * build:
 *	   g++ -std=c++17 blackjack.cpp -o blackjack
 *
 *  run: build
 *   ./blackjack
 * ```
 *
 * Disclaimer: This is not meant to throw shade at Dave, I fully expect someone of his knowledge, experience and accomplishments
 * to out program me any day of the week. It's quite obvious he kept the code on the simpler side on purpose, as C++ has
 * scary looking syntax, and as he mentions it can cause people to run away. I did not PR on his repo, because the code is
 * to different and may confuse people who watched the video to be confused. So I figured a gist
 * was the best way. Hope the code helps you.
 * */

#include <algorithm>
#include <cstdint>
#include <ctime>
#include <iostream>
#include <memory>
#include <optional>
#include <random>
#include <type_traits>
#include <vector>

namespace iterables {

/**
 * @brief Generic iterator class for enums.
 *
 * @detail Currently assumes the enumeration is contiguous (no gaps).
 * */
template <typename EnumIterable, EnumIterable beginValue, EnumIterable endValue>
class EnumerationIterator {
public:
  /**
   * @brief Default constructor builds an instance to the first value
   * in the enumeration.
   *
   * @detail Used in the begin() method.
   * */
  EnumerationIterator() noexcept : value_(static_cast<value_t>(beginValue)) {}

  /**
   * @brief Constructs an instance to a specified value.
   *
   * @detail Used in the end() method.
   * */
  EnumerationIterator(const EnumIterable &iter) noexcept
      : value_(static_cast<value_t>(iter)) {}

public:
  /**
   * @brief ++this overload
   *
   * @detail Increments the underlying value and then returns
   * an instance of itself. this++ not implemented, as it is
   * ineffecient and usually not needed.
   * */
  [[maybe_unused]] auto operator++() noexcept -> EnumerationIterator {
    ++this->value_;
    return *this;
  }

  /**
   * @brief Dereference overload
   *
   * @detail Gets an instance to the current underlying value
   * after casting it the type EnumIterable.
   * */
  [[nodiscard]] auto operator*() noexcept -> EnumIterable {
    return static_cast<EnumIterable>(this->value_);
  }

  /**
   * @brief Is equal overload
   * */
  [[nodiscard]] auto
  operator==(const EnumerationIterator &other_iterator) const noexcept -> bool {
    return this->value_ == other_iterator.value_;
  }

  /**
   * @brief Not equal overload
   * */
  [[nodiscard]] auto
  operator!=(const EnumerationIterator &other_iterator) const noexcept -> bool {
    return !(*this == other_iterator);
  }

public:
  /**
   * @brief Return the beginning value, this will use the default constructor.
   * */
  [[nodiscard]] auto begin() const noexcept -> EnumerationIterator {
    return *this;
  }

  /**
   * @brief Return the end value.
   * */
  [[nodiscard]] auto end() noexcept -> EnumerationIterator {
    // cache the value
    static const auto endIter = ++EnumerationIterator(endValue);
    return endIter;
  }

private:
  // Verifys the type is indeed an enumeration class
  // https://en.cppreference.com/w/cpp/types/underlying_type
  using value_t = typename std::underlying_type<EnumIterable>::type;
  std::int64_t value_;
};
} // namespace iterables

namespace blackjack {

enum class Rank : std::uint16_t {
  ACE = 1,
  TWO,
  THREE,
  FOUR,
  FIVE,
  SIX,
  SEVEN,
  EIGHT,
  NINE,
  TEN,
  JACK,
  QUEEN,
  KING
};

enum class Suit : std::uint16_t {
  HEARTS,
  DIAMONDS,
  CLUBS,
  SPADES,
};

class Card {
public:
  Card(Rank rank, Suit suit) noexcept : rank_(rank), suit_(suit) {}

  [[nodiscard]] auto getRank() const noexcept -> Rank { return this->rank_; }

  [[nodiscard]] auto getSuite() const noexcept -> Suit { return this->suit_; }

private:
  Rank rank_;
  Suit suit_;
};

class Deck {
public:
  using DealableCard = std::unique_ptr<Card>;

public:
  /**
   * @brief Builds a 52 card deck of 13 ranks with 4 suits,
   *
   * @detail Uses the custom EnumerationIterator template class to showcase
   * the C++ ability to iterate over enums. #RustIsntTheOnlyOne.
   * */
  Deck() {
    for (const auto &suit : SuitIterator()) {
      for (const auto &rank : RankIterator()) {
        this->cards_.emplace_back(std::make_unique<Card>(rank, suit));
      }
    }
  }

  /**
   * @brief How many cards are in the deck
   * */
  [[nodiscard]] auto size() -> std::size_t { return this->cards_.size(); }

  /**
   * @brief Uses a random number and The classic Mersenne Twister,
   * random number generator to shuffle the deck.
   * */
  auto shuffleDeck() {
    std::random_device random_number;
    std::mt19937 generator(random_number());
    std::shuffle(this->cards_.begin(), this->cards_.end(), generator);
  }

  /**
   * @brief Returns an optional card. Showing
   * that modern has C++ as an equivalent to Rusts Option<T> type;
   * */
  [[nodiscard]] auto drawCard() -> std::optional<DealableCard> {
    if (this->cards_.empty()) {
      return std::nullopt;
    }
    auto card = std::optional<DealableCard>(std::move(this->cards_.back()));
    this->cards_.pop_back();
    return card;
  }

private:
  using RankIterator =
      iterables::EnumerationIterator<Rank, Rank::ACE, Rank::KING>;
  using SuitIterator =
      iterables::EnumerationIterator<Suit, Suit::HEARTS, Suit::SPADES>;
  std::vector<DealableCard> cards_;
};

class Player {
public:
  auto addCard(std::optional<Deck::DealableCard> card) {
    // If the card is std::nullopt, then we know the deck is empty.
    if (card.has_value()) {
      this->hand_.emplace_back(std::move(card.value()));
    }
  }

  [[nodiscard]] auto getHandValue() -> uint16_t {
    uint16_t value = 0;
    uint16_t aces = 0;

    for (const auto &card : this->hand_) {
      auto cardValue = card->getRank();
      if (cardValue >= Rank::TEN) {
        cardValue = Rank::TEN;
      } else if (cardValue == Rank::ACE) {
        aces++;
        cardValue = static_cast<Rank>(11);
      }
      value += static_cast<uint16_t>(cardValue);
    }

    while (value > 21 && aces > 0) {
      value -= 10;
      aces--;
    }
    return value;
  }

private:
  std::vector<Deck::DealableCard> hand_;
};

} // namespace blackjack

auto main() -> int {

  blackjack::Deck deck;
  deck.shuffleDeck();

  blackjack::Player player;
  blackjack::Player dealer;
  std::cout << "Deck has: " << deck.size() << " cards\n";

  player.addCard(deck.drawCard());
  player.addCard(deck.drawCard());

  dealer.addCard(deck.drawCard());
  dealer.addCard(deck.drawCard());

  std::cout << "Player hand value: " << player.getHandValue() << '\n';
  std::cout << "Dealer hand value: " << dealer.getHandValue() << '\n';
  std::cout << "Deck has: " << deck.size() << " cards\n";

  return EXIT_SUCCESS;
}
