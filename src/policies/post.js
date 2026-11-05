// src/policies/post.js — every rule about who can do what to a post, in one file.
export const EDITABLE_FIELDS = ['title', 'body', 'status'];   // rule 5

export function can(user, action, post) {
  const isAuthor = user != null && user.id === post.authorId;
  const isAdmin = user?.role === 'admin';

  switch (action) {
    case 'read':   return post.status === 'published' || isAuthor;                    // rules 1, 2
    case 'update': return isAuthor;                                                   // rule 3
    case 'delete': return isAuthor || (isAdmin && post.status === 'published');      // rule 4
    default:       return false;                                                      // unknown action: deny
  }
}

// The same "read" rule as a SQL filter, for routes that return many posts.
// It lives next to can() so the two change together.
export function scopePosts(user) {
  return user
    ? { where: "status = 'published' OR author_id = ?", params: [user.id] }
    : { where: "status = 'published'", params: [] };
}
