"""Fixture for code_definition e2e tests.

Layout (1-based line numbers in comments refer to the line the IDENTIFIER
sits on — positions used by the tests below are derived from this file):

    1  module docstring
    3  GREETING = "hello"
    5  def make_config():            ← cursor here tests top-level def
    6      """Build a default config dict."""
    7      return {"timeout": 30, "retries": 3}   ← contains `{` (dict literal)
    9
    10 class Greeter:                ← cursor here tests class body
    11     """A class that greets."""
    13     def __init__(self, name):
    16     def greet(self):          ← cursor here tests a method inside a class
    17         """Return the greeting."""
    20     def config(self):
    21         return make_config()  ← call site; cursor here tests jump-to-def
    24 def use_all():
    25     g = Greeter("world")      ← call site on the class
    26     g.greet()                 ← call site on the method
    27     return g.config()
"""

GREETING = "hello"


def make_config():
    """Build a default config dict."""
    return {"timeout": 30, "retries": 3}


class Greeter:
    """A class that greets."""

    def __init__(self, name):
        self.name = name

    def greet(self):
        """Return the greeting."""
        return f"hello, {self.name}"

    def config(self):
        return make_config()


def use_all():
    g = Greeter("world")
    g.greet()
    return g.config()
