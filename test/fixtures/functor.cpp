// Source snippet: https://mayankj08.github.io/2017/07/02/Functors-In-C++/
struct MyAddFunctor {
  // Constructor
  MyAddFunctor(int inp) {
    x = inp;
  }

  // Defining operator()
  int operator()(int y) {
    return x + y;
  }

  int x;
};
