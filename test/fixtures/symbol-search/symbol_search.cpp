// A realistic C++ codebase exercising templates, namespaces, overloads,
// nested classes, enums, lambdas, and other features that stress symbol search.
//
// Scraped and adapted from real-world patterns in game engines, data structures,
// and scientific computing libraries.

#include <cmath>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

// ─── Basic namespace with nested hierarchy ─────────────────────────────────

namespace engine {
namespace math {

struct Vec3 {
    float x, y, z;

    Vec3() : x(0), y(0), z(0) {}
    Vec3(float x, float y, float z) : x(x), y(y), z(z) {}

    float length() const;
    Vec3 normalized() const;

    Vec3 operator+(const Vec3& other) const {
        return Vec3(x + other.x, y + other.y, z + other.z);
    }

    Vec3 operator*(float scalar) const {
        return Vec3(x * scalar, y * scalar, z * scalar);
    }

    bool operator==(const Vec3& other) const {
        return x == other.x && y == other.y && z == other.z;
    }
};

float Vec3::length() const {
    return std::sqrt(x * x + y * y + z * z);
}

Vec3 Vec3::normalized() const {
    float len = length();
    if (len > 0) {
        return Vec3(x / len, y / len, z / len);
    }
    return Vec3();
}

// Free function in namespace
inline float dot(const Vec3& a, const Vec3& b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

inline Vec3 cross(const Vec3& a, const Vec3& b) {
    return Vec3(
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x
    );
}

} // namespace math

namespace physics {

// Forward declaration
class RigidBody;

struct AABB {
    math::Vec3 min;
    math::Vec3 max;

    bool contains(const math::Vec3& point) const;
    bool intersects(const AABB& other) const;
    float volume() const;
};

bool AABB::contains(const math::Vec3& point) const {
    return point.x >= min.x && point.x <= max.x &&
           point.y >= min.y && point.y <= max.y &&
           point.z >= min.z && point.z <= max.z;
}

bool AABB::intersects(const AABB& other) const {
    return (min.x <= other.max.x && max.x >= other.min.x) &&
           (min.y <= other.max.y && max.y >= other.min.y) &&
           (min.z <= other.max.z && max.z >= other.min.z);
}

float AABB::volume() const {
    math::Vec3 size = max - min;
    return size.x * size.y * size.z;
}

// ─── Class with nested types and static members ────────────────────────────

class RigidBody {
public:
    enum class State : uint8_t {
        Static = 0,
        Dynamic = 1,
        Kinematic = 2,
    };

    struct Properties {
        float mass = 1.0f;
        float friction = 0.5f;
        float restitution = 0.3f;
        bool isTrigger = false;
    };

    using CollisionCallback = std::function<void(RigidBody& other)>;

    RigidBody(math::Vec3 position, Properties props = {})
        : position_(position), properties_(props), state_(State::Dynamic) {}

    // Getters
    const math::Vec3& getPosition() const { return position_; }
    State getState() const { return state_; }
    const Properties& getProperties() const { return properties_; }

    // Setters
    void setPosition(const math::Vec3& pos) { position_ = pos; }
    void setState(State state) { state_ = state; }

    // Physics methods
    void applyForce(const math::Vec3& force);
    void applyImpulse(const math::Vec3& impulse);
    void integrate(float dt);

    // Collision
    void onCollision(CollisionCallback callback) {
        collisionCallback_ = std::move(callback);
    }

    AABB getBounds() const;

private:
    math::Vec3 position_;
    math::Vec3 velocity_;
    math::Vec3 acceleration_;
    Properties properties_;
    State state_;
    CollisionCallback collisionCallback_;
};

void RigidBody::applyForce(const math::Vec3& force) {
    if (state_ == State::Dynamic) {
        acceleration_ = acceleration_ + force * (1.0f / properties_.mass);
    }
}

void RigidBody::applyImpulse(const math::Vec3& impulse) {
    if (state_ == State::Dynamic) {
        velocity_ = velocity_ + impulse * (1.0f / properties_.mass);
    }
}

void RigidBody::integrate(float dt) {
    if (state_ != State::Static) {
        velocity_ = velocity_ + acceleration_ * dt;
        position_ = position_ + velocity_ * dt;
        acceleration_ = math::Vec3();  // Reset acceleration
    }
}

AABB RigidBody::getBounds() const {
    // Simplified bounding box
    constexpr float halfSize = 0.5f;
    return AABB{
        position_ - math::Vec3(halfSize, halfSize, halfSize),
        position_ + math::Vec3(halfSize, halfSize, halfSize)
    };
}

} // namespace physics

// ─── Template-heavy data structures ────────────────────────────────────────

namespace data {

// Generic result type for error handling
template<typename T>
class Result {
public:
    static Result success(T value) {
        Result r;
        r.value_ = std::move(value);
        r.hasValue_ = true;
        return r;
    }

    static Result error(std::string message) {
        Result r;
        r.errorMessage_ = std::move(message);
        r.hasValue_ = false;
        return r;
    }

    bool ok() const { return hasValue_; }
    const T& value() const { return value_; }
    const std::string& errorMessage() const { return errorMessage_; }

    template<typename F>
    auto map(F&& func) -> Result<decltype(func(value_))> {
        if (hasValue_) {
            return Result<decltype(func(value_))>::success(func(value_));
        }
        return Result<decltype(func(value_))>::error(errorMessage_);
    }

private:
    T value_;
    std::string errorMessage_;
    bool hasValue_;
};

// Specialization for void
template<>
class Result<void> {
public:
    static Result success() {
        Result r;
        r.ok_ = true;
        return r;
    }

    static Result error(std::string message) {
        Result r;
        r.errorMessage_ = std::move(message);
        r.ok_ = false;
        return r;
    }

    bool ok() const { return ok_; }
    const std::string& errorMessage() const { return errorMessage_; }

private:
    std::string errorMessage_;
    bool ok_;
};

// ─── Intrusive linked list ─────────────────────────────────────────────────

template<typename T>
class IntrusiveList {
public:
    struct Node {
        T* next = nullptr;
        T* prev = nullptr;
    };

    void pushBack(T* item) {
        auto* node = static_cast<Node*>(item);
        if (tail_) {
            static_cast<Node*>(tail_)->next = item;
            node->prev = tail_;
        } else {
            head_ = item;
        }
        tail_ = item;
        size_++;
    }

    T* popFront() {
        if (!head_) return nullptr;
        auto* item = head_;
        head_ = static_cast<Node*>(item)->next;
        if (head_) {
            static_cast<Node*>(head_)->prev = nullptr;
        } else {
            tail_ = nullptr;
        }
        static_cast<Node*>(item)->next = nullptr;
        size_--;
        return item;
    }

    size_t size() const { return size_; }
    bool empty() const { return size_ == 0; }

    // Iterator support
    class iterator {
    public:
        iterator(T* ptr) : current_(ptr) {}
        T& operator*() { return *current_; }
        T* operator->() { return current_; }
        iterator& operator++() {
            current_ = static_cast<Node*>(current_)->next;
            return *this;
        }
        bool operator!=(const iterator& other) const {
            return current_ != other.current_;
        }

    private:
        T* current_;
    };

    iterator begin() { return iterator(head_); }
    iterator end() { return iterator(nullptr); }

private:
    T* head_ = nullptr;
    T* tail_ = nullptr;
    size_t size_ = 0;
};

// ─── Pool allocator ────────────────────────────────────────────────────────

template<typename T, size_t BlockSize = 1024>
class PoolAllocator {
public:
    PoolAllocator() = default;
    ~PoolAllocator() {
        while (head_) {
            auto* block = head_;
            head_ = head_->next;
            delete[] reinterpret_cast<char*>(block);
        }
    }

    template<typename... Args>
    T* allocate(Args&&... args) {
        if (!freeList_) {
            expand();
        }
        auto* slot = freeList_;
        freeList_ = *reinterpret_cast<T**>(freeList_);
        return new (slot) T(std::forward<Args>(args)...);
    }

    void deallocate(T* ptr) {
        ptr->~T();
        *reinterpret_cast<T**>(ptr) = freeList_;
        freeList_ = ptr;
    }

private:
    void expand() {
        auto* block = reinterpret_cast<char*>(
            new T[BlockSize]  // Not actually T objects, just raw memory
        );
        auto* node = new Block{block, head_};
        head_ = node;

        // Link free slots
        for (size_t i = 0; i < BlockSize - 1; ++i) {
            auto* slot = block + i * sizeof(T);
            *reinterpret_cast<T**>(slot) = reinterpret_cast<T*>(slot + sizeof(T));
        }
        *reinterpret_cast<T**>(block + (BlockSize - 1) * sizeof(T)) = freeList_;
        freeList_ = reinterpret_cast<T*>(block);
    }

    struct Block {
        char* memory;
        Block* next;
    };

    Block* head_ = nullptr;
    T* freeList_ = nullptr;
};

} // namespace data

// ─── Overloaded functions ──────────────────────────────────────────────────

namespace util {

// Multiple overloads of the same function name
std::string toString(int value) {
    return std::to_string(value);
}

std::string toString(float value) {
    return std::to_string(value);
}

std::string toString(bool value) {
    return value ? "true" : "false";
}

std::string toString(const math::Vec3& vec) {
    return "(" + std::to_string(vec.x) + ", " +
                 std::to_string(vec.y) + ", " +
                 std::to_string(vec.z) + ")";
}

// Template function
template<typename Container>
auto sum(const Container& c) -> typename Container::value_type {
    typename Container::value_type total{};
    for (const auto& item : c) {
        total += item;
    }
    return total;
}

// Function with default arguments
void log(const std::string& message,
         const std::string& category = "default",
         int severity = 0) {
    // In real code, this would log somewhere
    (void)message;
    (void)category;
    (void)severity;
}

// ─── Function objects and lambdas ──────────────────────────────────────────

struct Transform {
    math::Vec3 operator()(const math::Vec3& v) const {
        return v * scale_ + offset_;
    }

    float scale_ = 1.0f;
    math::Vec3 offset_;
};

// Factory function returning a lambda
auto makeFilter(float minX, float maxX) {
    return [minX, maxX](const math::Vec3& v) {
        return v.x >= minX && v.x <= maxX;
    };
}

} // namespace util

// ─── Anonymous namespace ───────────────────────────────────────────────────

namespace {

struct InternalState {
    int frameCount = 0;
    float deltaTime = 0.016f;
    bool isRunning = false;
};

static InternalState g_state;

void updateGlobalState(float dt) {
    g_state.deltaTime = dt;
    g_state.frameCount++;
}

} // anonymous namespace

// ─── Inheritance hierarchy ─────────────────────────────────────────────────

namespace scene {

class Entity {
public:
    explicit Entity(std::string name) : name_(std::move(name)) {}
    virtual ~Entity() = default;

    virtual void update(float dt) = 0;
    virtual void render() const = 0;

    const std::string& getName() const { return name_; }
    bool isActive() const { return active_; }
    void setActive(bool active) { active_ = active; }

protected:
    std::string name_;
    bool active_ = true;
};

class GameObject : public Entity {
public:
    GameObject(std::string name, math::Vec3 position)
        : Entity(std::move(name)), position_(position) {}

    void update(float dt) override {
        (void)dt;
        // Default update behavior
    }

    void render() const override {
        // Default render behavior
    }

    const math::Vec3& getPosition() const { return position_; }
    void setPosition(const math::Vec3& pos) { position_ = pos; }

protected:
    math::Vec3 position_;
};

class Character : public GameObject {
public:
    Character(std::string name, math::Vec3 position, float health)
        : GameObject(std::move(name), position), health_(health) {}

    void update(float dt) override {
        GameObject::update(dt);
        // Character-specific update
    }

    void render() const override {
        // Character-specific render
    }

    float getHealth() const { return health_; }
    void takeDamage(float damage) {
        health_ = std::max(0.0f, health_ - damage);
        if (health_ <= 0) {
            onDeath();
        }
    }

    bool isAlive() const { return health_ > 0; }

protected:
    virtual void onDeath() {
        setActive(false);
    }

    float health_;
};

class Player : public Character {
public:
    Player(std::string name, math::Vec3 position)
        : Character(std::move(name), position, 100.0f) {}

    void update(float dt) override {
        Character::update(dt);
        // Player-specific update
    }

    int getScore() const { return score_; }
    void addScore(int points) { score_ += points; }

protected:
    void onDeath() override {
        Character::onDeath();
        // Game over logic
    }

private:
    int score_ = 0;
};

} // namespace scene

// ─── Enum utilities ────────────────────────────────────────────────────────

namespace config {

enum class LogLevel : int {
    Trace = 0,
    Debug = 1,
    Info = 2,
    Warn = 3,
    Error = 4,
    Fatal = 5,
};

enum class OutputFormat {
    Text,
    Json,
    Csv,
};

// Enum to string conversion
const char* logLevelToString(LogLevel level) {
    switch (level) {
        case LogLevel::Trace: return "TRACE";
        case LogLevel::Debug: return "DEBUG";
        case LogLevel::Info:  return "INFO";
        case LogLevel::Warn:  return "WARN";
        case LogLevel::Error: return "ERROR";
        case LogLevel::Fatal: return "FATAL";
        default: return "UNKNOWN";
    }
}

// Settings struct with enum members
struct Settings {
    LogLevel logLevel = LogLevel::Info;
    OutputFormat format = OutputFormat::Text;
    bool verbose = false;
    int maxRetries = 3;
    float timeout = 30.0f;
};

// Global settings instance
Settings g_settings;

void setLogLevel(LogLevel level) {
    g_settings.logLevel = level;
}

} // namespace config
